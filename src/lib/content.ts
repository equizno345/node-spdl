import { PassThrough, pipeline, Readable } from "node:stream";
import { pipeline as pipelineAsync } from "node:stream/promises";
import { decryptSegment } from "shifro";
import undici from "undici";

import { Spotify } from "./client.js";
import { Endpoints, AudioType } from "./const.js";
import { createPPStreamDecryptor } from "./decrypt.js";
import { SpotifyApiError, SpotifyStreamError } from "./errors.js";
import { EpisodeMetadata, SpdlOptions, StorageResolveResponse, TrackFile, TrackMetadata } from "./types.js";

type PlayableMetadata = EpisodeMetadata | TrackMetadata;

export class CDNStreamer {
    client: Spotify;
    stream: PassThrough;

    constructor(
        client: Spotify,
        stream: PassThrough
    ) {
        this.client = client;
        this.stream = stream;
    }

    async loadContent(
        file: TrackFile,
        response: StorageResolveResponse | string,
        type: AudioType
    ) {
        if (file.format.startsWith("OGG")) {
            let url: string;
            if (typeof response !== "string") {
                let filteredUrls = response.cdnurl.filter((url) => {
                    const urlObj = new URL(url)
                    // these hostnames are known to have bad certs
                    return (
                        !urlObj.hostname.includes("audio4-gm-fb") &&
                        !urlObj.hostname.includes("audio-gm-fb")
                    )
                });
                url = filteredUrls[Math.floor(Math.random() * (filteredUrls.length - 1))];
            } else {
                url = response;
            }

            const key = await this.client.playplay.getKey(file.fileId, type);

            try {
                const { body } = await undici.request(url, { method: "GET" });

                if (!body) {
                    throw new SpotifyStreamError("Could not get stream from CDN.");
                }

                const decryptStream = createPPStreamDecryptor(key);
                return pipeline(
                    body,
                    decryptStream,
                    this.stream,
                    (error) => {
                        if (error) {
                            throw new SpotifyStreamError(error.message);
                        }
                    }
                );
            } catch (error) {
                this.stream.destroy(error as any);
            }
        } else if (file.format.startsWith("MP4")) {
            if (!this.client.widevine.device) {
                throw new SpotifyStreamError("You need to provide a Widevine device in order to decrypt AAC (MP4) files.");
            }

            if (typeof response != "object") {
                throw new SpotifyStreamError("Storage resolve provided an invalid result.");
            }
        
            const seektable = await this.client.widevine.getSeektable(file.fileId);
            const pssh = Buffer.from(seektable.pssh_widevine || seektable.pssh!, "base64");

            const key = await this.client.widevine.getKey(pssh);
            const urls = response.cdnurl;
            if (!urls.length) throw new SpotifyStreamError("Spotify returned no audio URLs.");
            if (this.stream.destroyed) return;
            const controller = new AbortController();
            const abort = () => controller.abort();
            this.stream.once("close", abort);
            const encrypted = this.hasEncryptedSamples.bind(this);
            async function* segments() {
                let start = 0;
                const sizes = [seektable.offset, ...seektable.segments.map(segment => segment[0])];
                for (const [index, size] of sizes.entries()) {
                    const end = start + size - 1;
                    if (!Number.isSafeInteger(end)) throw new SpotifyStreamError("Invalid Spotify audio range.");
                    const chunk = await undici.request(urls[index % urls.length], {
                        method: "GET", headers: {range: `bytes=${start}-${end}`},
                        signal: controller.signal, headersTimeout: 15000, bodyTimeout: 15000
                    });
                    if (chunk.statusCode !== 206) {
                        await chunk.body.dump();
                        throw new SpotifyApiError(chunk.statusCode, "Spotify audio range request failed",
                            typeof chunk.headers["retry-after"] === "string" ? chunk.headers["retry-after"] : undefined);
                    }
                    const range = /^bytes (\d+)-(\d+)\/\d+$/.exec(String(chunk.headers["content-range"]));
                    if (!range || Number(range[1]) !== start || Number(range[2]) !== end) {
                        chunk.body.destroy();
                        throw new SpotifyStreamError("Spotify returned an unexpected audio range.");
                    }
                    const buffers: Buffer[] = [];
                    let received = 0;
                    for await (const buffer of chunk.body) {
                        received += buffer.length;
                        if (received > size) {
                            chunk.body.destroy();
                            throw new SpotifyStreamError("Spotify audio range exceeded its expected size.");
                        }
                        buffers.push(Buffer.from(buffer));
                    }
                    if (received !== size) throw new SpotifyStreamError("Spotify returned an incomplete audio range.");
                    const segment = Buffer.concat(buffers);
                    // Spotify's clear lead has no senc box. Keep it intact; decrypt the
                    // initialization and encrypted fragments with the original dependency.
                    yield index === 0 || encrypted(segment)
                        ? Buffer.from(await decryptSegment(segment, {key, encryptionScheme: "cenc"}))
                        : segment;
                    start = end + 1;
                }
            }
            try {
                await pipelineAsync(Readable.from(segments(), {objectMode: false}), this.stream);
            } finally {
                this.stream.removeListener("close", abort);
                controller.abort();
            }
        } else if (file.format.startsWith("MP3")) {
            let url: string;
            if (typeof response !== "string") {
                url = response.cdnurl[Math.floor(Math.random() * (response.cdnurl.length - 1))];
            } else {
                url = response;
            }

            // file is unencrypted, download and pipe
            let request = await undici.request(url, { method: "GET" });
            if (request.statusCode != 200) {
                // fallback to static URL
                url = Endpoints.PREVIEW + file.fileId;
                request = await undici.request(url, { method: "GET" });
            }

            request.body.pipe(this.stream);
        } else {
            throw new SpotifyStreamError("Sorry, this format is not supported yet.");
        }
    }

    private hasEncryptedSamples(segment: Buffer, start = 0, end = segment.length): boolean {
        let encrypted = false;
        while (start < end) {
            if (start + 8 > end) throw new SpotifyStreamError("Invalid Spotify MP4 fragment.");
            const size = segment.readUInt32BE(start);
            const type = segment.toString("ascii", start + 4, start + 8);
            if (size < 8 || start + size > end) throw new SpotifyStreamError("Invalid Spotify MP4 box.");
            if (type === "senc") encrypted = true;
            if ((type === "moof" || type === "traf") && this.hasEncryptedSamples(segment, start + 8, start + size)) encrypted = true;
            start += size;
        }
        return encrypted;
    }
}

export class PlayableContentStreamer {
    client: Spotify;
    cdn: CDNStreamer;
    preload: boolean;
    stream: PassThrough;

    constructor(
        client: Spotify, 
        stream: PassThrough,
        preload: boolean = false
    ) {
        this.client = client;
        this.cdn = new CDNStreamer(client, stream);
        this.preload = preload;
        this.stream = stream;
    }

    async loadStream(
        content: PlayableMetadata,
        file: TrackFile,
        type: AudioType
    ) {
        if (!content) {
            throw new SpotifyStreamError("Content is unknown.");
        }

        const response = await this.resolveStorage(file);
        switch (response.result) {
            case "CDN":
                return await this.cdn.loadContent(file, response, type);
            default:
                throw new SpotifyStreamError("Spotify audio storage is unavailable.");
        }
    }

    async loadContent(
        content: PlayableMetadata,
        options: SpdlOptions,
        type: AudioType
    ) {
        const file = content.files.find((f) => f.format.startsWith(options.format!)) ||
            content.preview?.find((f) => f.format.startsWith(options.format!));
            
        if (!file) {
            throw new SpotifyStreamError("The track is not available in the selected quality.");
        }

        return this.loadStream(content, file, type);
    }

    private async resolveStorage(file: TrackFile) {
        const endpoint = this.preload ? Endpoints.STORAGE_RESOLVE_INTERACTIVE_PREFETCH : Endpoints.STORAGE_RESOLVE_INTERACTIVE;
        const mp4Format = {MP4_128: 10, MP4_256: 11}[file.format as "MP4_128" | "MP4_256"];
        const url = mp4Format ? `${Endpoints.STORAGE_RESOLVE_MP4}${mp4Format}/${file.fileId}` : `${endpoint}${file.fileId}`;
        const response: StorageResolveResponse = await this.client.request(
            `${url}?version=10000000&product=9&platform=39&alt=json`
        );
        if (!response) {
            throw new SpotifyStreamError("The file could not be fetched from the storage.");
        }

        return response;
    }
}