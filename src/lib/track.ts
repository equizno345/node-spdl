import { Spotify } from "./client.js";
import { Endpoints } from "./const.js";
import { parseLyrics, parseTrack, parseTrackMetadata } from "./parser.js";
import { ColorLyrics, SpdlFormat, Track, TrackMetadata } from "./types.js";
import { getIdFromQuery } from "./url.js";
import { SpotifyApiError, SpotifyError } from "./errors.js";
import { base62 } from "./util.js";
import { AudioFilesBatchRequest, AudioFilesBatchResponse, AudioFilesResponse } from "./proto.js";

export class TrackClient {
    readonly client: Spotify;

    constructor(client: Spotify) {
        this.client = client;
    }

    public async get(id: string): Promise<Track> {
        id = getIdFromQuery(id);
        if (!/^[a-zA-Z0-9]{22}$/.test(id)) throw new SpotifyError("Invalid Spotify track");
        let hash = await this.client.playlists.queryHash(false, "getTrack");
        const body = () => ({operationName: "getTrack", variables: {uri: `spotify:track:${id}`},
            extensions: {persistedQuery: {version: 1, sha256Hash: hash}}});
        let response: any;
        try {response = await this.client.request(Endpoints.QUERY, body());}
        catch (error) {
            if (!(error instanceof SpotifyApiError && error.statusCode === 412)) throw error;
            response = {errors: [{message: "PersistedQueryNotFound"}]};
        }
        if (response?.errors?.some((error: any) => error.message === "PersistedQueryNotFound")) {
            hash = await this.client.playlists.queryHash(true, "getTrack");
            response = await this.client.request(Endpoints.QUERY, body());
        }
        if (response?.errors?.length) throw new SpotifyError("Spotify could not read this track");
        const track = response?.data?.trackUnion;
        if (!track || ["NotFound", "GenericError"].includes(track.__typename))
            throw new SpotifyApiError(404, "Spotify track was not found");
        if (track.uri !== `spotify:track:${id}` || typeof track.name !== "string")
            throw new SpotifyError("Invalid Spotify track response");
        return parseTrack(track);
    } 

    public async getMetadata(gid: string, format?: SpdlFormat): Promise<TrackMetadata> {
        if (!/^[a-f0-9]{32}$/i.test(gid)) throw new SpotifyError("Invalid Spotify track identifier");
        const meta = await this.client.request(`${Endpoints.TRACK_METADATA}${gid}`);
        const track = parseTrackMetadata(meta);
        // Web-player AAC descriptors are absent from native AUDIO_FILES metadata.
        if (format?.startsWith("MP4")) {
            const uri = `spotify:track:${base62.encode(Buffer.from(gid, "hex")).padStart(22, "0")}`;
            const playback = await this.client.request(`${Endpoints.TRACK_PLAYBACK}${uri}?manifestFileFormat=file_ids_mp4`);
            // Spotify may relink a regional recording. Only accept an explicit
            // link back to the requested track; other entries can be videos.
            const linked = Object.entries(playback?.media || {}).filter(([key, value]: [string, any]) =>
                value?.item?.metadata?.linked_from_uri === uri &&
                value.item.metadata.uri === key && value.item.track_type === "AUDIO");
            const item = playback?.media?.[uri]?.item || (linked.length === 1 ? (linked[0][1] as any).item : undefined);
            const files: unknown = item?.manifest?.file_ids_mp4;
            if (!Array.isArray(files)) throw new SpotifyError("Invalid Spotify AAC metadata");
            const formats: Record<string, string> = {"10": "MP4_128", "11": "MP4_256"};
            for (const file of files) {
                if (!Object.hasOwn(formats, String(file?.format))) continue;
                const mapped = formats[String(file?.format)];
                if (typeof file.file_id !== "string" || !/^[a-f0-9]{40}$/i.test(file.file_id))
                    throw new SpotifyError("Invalid Spotify AAC file descriptor");
                if (!track.files.some(existing => existing.fileId === file.file_id && existing.format === mapped))
                    track.files.push({fileId: file.file_id, format: mapped});
            }
            return track;
        }
        if (track.files.length || !Array.isArray(meta.audio_formats)) return track;

        // New v4 metadata contains original-audio descriptors, not playable file IDs.
        const uri = `spotify:track:${base62.encode(Buffer.from(gid, "hex")).padStart(22, "0")}`;
        const body = AudioFilesBatchRequest.encode({entityRequest: [{entityUri: uri, query: [{extensionKind: 5}]}]}).finish();
        const response = await this.client.request(Endpoints.EXTENDED_METADATA, body, {protobuf: true});
        let files: any;
        try {
            const batch: any = AudioFilesBatchResponse.decode(response);
            const extension = batch.extendedMetadata.find((item: any) => item.extensionKind === 5);
            const providerStatus = extension?.header?.providerErrorStatus;
            if (providerStatus && providerStatus !== 200) throw new SpotifyApiError(providerStatus, "Spotify audio metadata provider failed");
            const entry = extension?.extensionData?.find((item: any) => item.entityUri === uri);
            const status = entry?.header?.statusCode;
            if (status && status !== 200) throw new SpotifyApiError(status, "Spotify audio metadata was unavailable");
            if (!entry || status !== 200 || !entry.extensionData?.typeUrl?.endsWith("/spotify.extendedmetadata.audiofiles.AudioFilesExtensionResponse"))
                throw new SpotifyError("Invalid Spotify audio files response");
            files = (AudioFilesResponse.decode(entry.extensionData.value) as any).files;
        } catch (error) {
            if (error instanceof SpotifyError || error instanceof SpotifyApiError) throw error;
            throw new SpotifyError("Invalid Spotify audio files response");
        }
        const formats: Record<number, string> = {0: "OGG_VORBIS_96", 1: "OGG_VORBIS_160", 2: "OGG_VORBIS_320", 3: "MP3_256", 4: "MP3_320", 5: "MP3_160", 6: "MP3_96", 7: "MP3_160_ENC", 8: "AAC_24", 9: "AAC_48", 16: "FLAC_FLAC", 18: "XHE_AAC_24", 19: "XHE_AAC_16", 20: "XHE_AAC_12", 22: "FLAC_FLAC_24BIT"};
        if (!Array.isArray(files)) throw new SpotifyError("Invalid Spotify audio files response");
        track.files = files.map((item: any) => {
            const file = item.file;
            if (!file || file.fileId?.length !== 20 || !formats[file.format]) throw new SpotifyError("Invalid Spotify audio file descriptor");
            return {fileId: Buffer.from(file.fileId).toString("hex"), format: formats[file.format]};
        });
        if (!track.files.length) throw new SpotifyError("No playable Spotify audio files were returned");
        return track;
    }

    /**
     * Get lyrics of a track
     * @param query ID or URL of track 
     * @returns Lyrics of song
     * @throws `404` if the track doesn't have lyrics.
     */
    public async lyrics(query: string): Promise<ColorLyrics> {
        const id = getIdFromQuery(query);

        const track = await this.get(id);
        const request = await this.client.request(`${Endpoints.COLOR_LYRICS}${track.id}?format=json&vocalRemoval=false`);

        const lyrics = request["lyrics"];
        return parseLyrics(lyrics);
    }
}
