import { PassThrough, Readable } from "node:stream";
import undici from "undici";
import unplayplay from "@spdl/unplayplay";

import { ArtistClient } from "./artist.js";
import { Endpoints, AudioType, premiumFormats } from "./const.js";
import { PlayableContentStreamer } from "./content.js";
import { createSpotifyEntity, EpisodeEntity, PlayableEntity, TrackEntity } from "./entity.js";
import { SpotifyApiError, SpotifyAuthError, SpotifyError, SpotifyStreamError } from "./errors.js";
import { PlaylistClient } from "./playlist.js";
import { PlayPlayClient } from "./playplay.js";
import { PodcastClient } from "./podcast.js";
import { getSpotifyTotp } from "./totp.js";
import { TrackClient } from "./track.js";
import { SpdlClientOptions, SpdlOptions, SpdlSearchOptions } from "./types.js";
import { validateURL } from "./url.js";
import { UserClient } from "./user.js";
import { WidevineClient } from "./widevine.js";

/**
 * The `Spotify` class initializes a Spotify API client.
 * 
 * @param {SpdlClientOptions} options Authenticate with your Spotify account.
 * @see [How to extract an sp_dc cookie](https://github.com/PwLDev/node-spdl?tab=readme-ov-file#how-to-get-a-cookie-)
 */
export class Spotify {
    accessToken: string = "";
    clientId: string = "";
    clientToken: string = "";
    cookie: string = "";
    accessExpiration: number = 0;
    clientExpiration: number = 0;
    readonly options: SpdlClientOptions;
    private accessRefresh?: Promise<void>;
    private clientRefresh?: Promise<void>;

    public artists: ArtistClient;
    public playlists: PlaylistClient;
    public playplay: PlayPlayClient;
    public podcasts: PodcastClient;
    public tracks: TrackClient;
    public user: UserClient;
    public widevine: WidevineClient;

    constructor(options: SpdlClientOptions) {
        if (options.accessToken) {
            this.accessToken = options.accessToken;
        } else {
            if (options.cookie) {
                this.cookie = options.cookie;
            } else {
                throw new SpotifyAuthError(`A valid "sp_dc" cookie or access token must be provided.`);
            }
        }

        if (options.clientToken) {
            this.clientToken = options.clientToken;
            // Caller-supplied tokens have no known expiry and remain caller-managed.
            this.clientExpiration = Infinity;
        }
        if (options.cookie) this.cookie = options.cookie;

        if (!options.forcePremium) {
            options.forcePremium = false;
        }

        if (!options.unplayplay) {
            options.unplayplay = unplayplay;
        }

        this.options = options;

        this.artists = new ArtistClient(this);
        this.playlists = new PlaylistClient(this);
        this.playplay = new PlayPlayClient(this);
        this.podcasts = new PodcastClient(this);
        this.tracks = new TrackClient(this);
        this.user = new UserClient(this);
        this.widevine = new WidevineClient(this);
    }

    /**
     * Initialize a `Spotify` instance with logged in credentials.
     * A valid sp_dc cookie or non-anonymous (logged in) access token must be provided.
     * 
     * @param {SpdlClientOptions} options Authenticate with your Spotify account.
     * @see https://github.com/PwLDev/node-spdl?tab=readme-ov-file#how-to-get-a-cookie How to extract a sp_dc cookie.
     * @example
     * ```js
     * const client = await Spotify.create({
     *   cookie: "sp_dc=some-cookie-here"
     * });
     * ```
     */
    static async create(options: SpdlClientOptions) {
        const instance = new Spotify(options);

        if (options.accessToken) {
            instance.accessToken = options.accessToken;
        }
        if (options.cookie) {
            instance.cookie = options.cookie;
            await instance.refresh();
        }
        if (!options.cookie && !options.accessToken) {
            throw new SpotifyAuthError(`A valid "sp_dc" cookie or access token must be provided.`);
        }

        return instance;
    }

    getHeaders(): Record<string, string> {
        return {
            "Authorization": `Bearer ${this.accessToken}`,
            ...(this.clientToken ? {"Client-Token": this.clientToken} : {}),
            "Accept": "application/json",
            "Accept-Language": "*",
            "Connection": "keep-alive",
            "Content-Type": "application/json",
            "Origin": "https://open.spotify.com",
            "Referer": "https://open.spotify.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            "app-platform": "WebPlayer"
        }
    }

    getRawHeaders(): Record<string, string> {
        return {
            "Authorization": `Bearer ${this.accessToken}`,
            ...(this.clientToken ? {"Client-Token": this.clientToken} : {}),
            "Accept": "*",
            "Accept-Language": "*",
            "Connection": "keep-alive"
        }
    }

    /**
     * Refreshes and ensures the authentication tokens are valid.
     */
    public async refresh(): Promise<void> {
        const now = Date.now();
        if (this.cookie && (!this.accessToken || now >= this.accessExpiration)) {
            await this.refreshToken();
        }
        if (this.clientId && (!this.clientToken || Date.now() >= this.clientExpiration)) {
            await this.refreshClient();
        }
    }

    /**
     * Refresh the access token if expiration time expired.
     */
    public async refreshToken(): Promise<void> {
        const now = Date.now();
        if (now < this.accessExpiration && this.accessToken) return;
        if (this.accessRefresh) return this.accessRefresh;
        this.accessRefresh = (async () => {

            const { otp, version } = await getSpotifyTotp();
            const headers = {
                "Referer": "https://open.spotify.com",
                "User-Agent": this.getHeaders()["User-Agent"]
            };
            if (this.cookie.length) {
                Object.assign(headers, { "Cookie": this.cookie });
            }

            const tokenRequest = await undici.request(
                Endpoints.TOKEN,
                {
                    headers,
                    method: "GET",
                    headersTimeout: 15000,
                    bodyTimeout: 15000,
                    query: {
                        reason: "transport",
                        productType: "web-player",
                        totp: otp,
                        totpServer: otp,
                        totpVer: version.toString(),
                    }
                }
            );

            if (tokenRequest.statusCode !== 200) {
                await tokenRequest.body.dump();
                // Spotify signals rejected cookies with a same-origin token
                // redirect before returning 401. Recognize it without forwarding
                // credentials to a redirect destination or exposing its query.
                if ([301, 302, 303, 307, 308].includes(tokenRequest.statusCode) &&
                    typeof tokenRequest.headers.location === "string") {
                    let redirect: URL | undefined;
                    try { redirect = new URL(tokenRequest.headers.location, Endpoints.TOKEN); } catch {}
                    const tokenUrl = new URL(Endpoints.TOKEN);
                    if (redirect?.origin === tokenUrl.origin && redirect.pathname === tokenUrl.pathname &&
                        redirect.searchParams.has("_authfailed")) {
                        throw new SpotifyAuthError("Spotify rejected the saved login. Reconnect Spotify to continue.");
                    }
                }
                throw new SpotifyApiError(tokenRequest.statusCode, "Spotify login request failed",
                    typeof tokenRequest.headers["retry-after"] === "string" ? tokenRequest.headers["retry-after"] : undefined);
            }
            const response: any = await tokenRequest.body.json();
            const isAnonymous = response["isAnonymous"];

            if (isAnonymous) {
                throw new SpotifyAuthError("You must provide a valid sp_dc cookie from a Spotify logged in browser.\nRefer to https://github.com/PwLDev/node-spdl#readme to see how to extract a cookie.");
            }
            if (typeof response.accessToken !== "string" || !response.accessToken ||
                typeof response.clientId !== "string" || !response.clientId ||
                !Number.isFinite(response.accessTokenExpirationTimestampMs) || response.accessTokenExpirationTimestampMs <= Date.now())
                throw new SpotifyError("Spotify login is temporarily unavailable");

            if (this.clientId && this.clientId !== response.clientId) {
                this.clientToken = "";
                this.clientExpiration = 0;
            }
            this.accessToken = response["accessToken"];
            this.clientId = response["clientId"];

            const expirationTime = response["accessTokenExpirationTimestampMs"];
            if (expirationTime) {
                this.accessExpiration = expirationTime;
            }
        })();
        try {await this.accessRefresh;}
        finally {this.accessRefresh = undefined;}
    }

    public async refreshClient(): Promise<void> {
        const now = Date.now();
        if (now < this.clientExpiration && this.clientToken) return;
        if (this.clientRefresh) return this.clientRefresh;
        this.clientRefresh = (async () => {

            const clientPayload = await this.getClientPayload();
            const clientToken = await undici.request(
                Endpoints.CLIENT_TOKEN,
                {
                    method: "POST",
                    body: JSON.stringify(clientPayload),
                    headers: {
                        "Accept": "application/json",
                        "Content-Type": "application/json"
                    },
                    headersTimeout: 15000,
                    bodyTimeout: 15000
                }
            );

            if (clientToken.statusCode !== 200) {
                await clientToken.body.dump();
                throw new SpotifyApiError(clientToken.statusCode, "Spotify client token request failed",
                    typeof clientToken.headers["retry-after"] === "string" ? clientToken.headers["retry-after"] : undefined);
            }
            const response = await clientToken.body.json() as {
                granted_token?: {token?: string; refresh_after_seconds?: number; expires_after_seconds?: number}
            };
            const granted = response.granted_token;
            const ttl = Math.min(granted?.refresh_after_seconds ?? Infinity, granted?.expires_after_seconds ?? Infinity);
            if (typeof granted?.token !== "string" || !granted.token || !Number.isFinite(ttl) || ttl <= 0)
                throw new SpotifyAuthError("Spotify did not grant a valid client token.");
            this.clientToken = granted.token;
            this.clientExpiration = now + ttl * 1000;
        })();
        try {await this.clientRefresh;}
        finally {this.clientRefresh = undefined;}
    }

    public async request(endpoint: string, body?: Record<string, unknown> | Uint8Array, options: {protobuf?: boolean} = {}): Promise<any> {
        await this.refresh();
        if (!this.accessToken.length) {
            throw new SpotifyAuthError("This client is not authenticated yet.");
        }

        const request = await undici.fetch(endpoint, {
            headers: {...this.getHeaders(), ...(options.protobuf ? {
                "Accept": "application/x-protobuf", "Content-Type": "application/x-protobuf"
            } : {})},
            method: body ? "POST" : "GET",
            ...(body ? {body: body instanceof Uint8Array ? Buffer.from(body) : JSON.stringify(body)} : {}),
            redirect: "error",
            signal: AbortSignal.timeout(15000)
        });
        const chunks: Buffer[] = [];
        let length = 0;
        const reader = request.body?.getReader();
        if (!reader) throw new SpotifyError("Spotify returned an empty response");
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            length += value.length;
            if (length > 8 * 1024 * 1024) {
                await reader.cancel();
                throw new SpotifyError("Spotify response exceeded the metadata size limit");
            }
            chunks.push(Buffer.from(value));
        }
        if (!request.ok)
            throw new SpotifyApiError(request.status, "Spotify metadata request failed", request.headers.get("retry-after") || undefined);
        const data = Buffer.concat(chunks);
        return options.protobuf ? data : JSON.parse(data.toString("utf8"));
    }

    private async getClientPayload() {
        if (!this.clientId) throw new SpotifyAuthError("A cookie session or a caller-supplied client token is required.");
        // Read public player configuration; never send account credentials to discovery.
        const page = await undici.fetch(Endpoints.HOME_PAGE, {
            headers: {"User-Agent": this.getHeaders()["User-Agent"]},
            signal: AbortSignal.timeout(15000)
        });
        if (!page.ok) throw new SpotifyApiError(page.status, "Spotify player configuration request failed", page.headers.get("retry-after") || undefined);
        const html = await page.text();
        const config = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
            .find(match => /\bid\s*=\s*["']appServerConfig["']/.test(match[1]))?.[2];
        let clientVersion: unknown;
        if (config) {
            for (const source of [config, Buffer.from(config, "base64").toString("utf8")]) {
                try {clientVersion = JSON.parse(source).clientVersion;}
                catch {continue;}
                if (typeof clientVersion === "string") break;
            }
        }
        if (typeof clientVersion !== "string" || !/^[a-zA-Z0-9.\-]{1,80}$/.test(clientVersion))
            throw new SpotifyAuthError("Failed to get the client version.");
        return {
            client_data: {
                client_id: this.clientId,
                client_version: clientVersion,
                js_sdk_data: {}
            },
        }
    }

    /**
     * Downloads a track from Spotify by its URL.
     * @param {String} url URL of the track
     * @param {SpdlOptions} options Options for downloading the track.
     */
    public download(
        url: string,
        options: SpdlOptions
    ): Readable {
        const stream = new PassThrough({
            highWaterMark: options.highWaterMark || 1024 * 512
        });

        if (validateURL(url)) {
            const content = createSpotifyEntity(url);
            if (!(content instanceof PlayableEntity)) {
                throw new SpotifyError("An unplayable Spotify entity was provided.");
            }

            this.downloadFromEntity(stream, content, options).catch(error =>
                stream.destroy(error instanceof Error ? error : new SpotifyError("Spotify download failed")));
        } else {
            stream.destroy();
            throw new SpotifyAuthError("An invalid Spotify URL was provided.");
        }

        return stream;
    }

    protected async downloadFromEntity(
        stream: PassThrough,
        content: PlayableEntity,
        options: SpdlOptions
    ) {
        if (!options.format) {
            // Default to a reasonable quality
            options.format = "OGG_VORBIS_160";
        }

        if (!options.encrypt) {
            options.encrypt = false;
        }

        if (!options.preload) {
            options.preload = false;
        }

        const feeder = new PlayableContentStreamer(this, stream, options.preload);
        const isPremium = await this.user.isPremium();

        if (content instanceof TrackEntity) {
            const metadata = await this.tracks.getMetadata(content.toHex(), options.format);
            const formats = [
                ...metadata.files.map((k) => k.format),
                ...metadata.preview.map((k) => k.format)
            ];

            if (!formats.includes(options.format)) {
                throw new SpotifyStreamError("Format provided is not supported by this content.");
            }
    
            if (
                premiumFormats.includes(options.format) 
                && !isPremium
            ) {
                throw new SpotifyAuthError("Selected format is only available for Spotify premium accounts.");
            }
    
            await feeder.loadContent(metadata, options, AudioType.AUDIO_TRACK);
        } else if (content instanceof EpisodeEntity) {
            const metadata = await this.podcasts.getMetadata(content.toHex());
            const formats = metadata.files.map((k) => k.format);

            if (!formats.includes(options.format)) {
                throw new SpotifyStreamError("Format provided is not supported by this content.");
            }
    
            if (
                premiumFormats.includes(options.format) 
                && !isPremium
            ) {
                throw new SpotifyAuthError("Selected format is only available for Spotify premium accounts.");
            }

            await feeder.loadContent(metadata, options, AudioType.AUDIO_EPISODE);
        }
    }

    public async search(query: string, options: SpdlSearchOptions = {}) {
        const request = await undici.request(Endpoints.SEARCH, {
            headers: this.getHeaders(),
            method: "GET",
            query: {
                ...options,
                q: query,
                type: options.type?.length ? options.type.join(",") : undefined
            }
        });
    }
}
