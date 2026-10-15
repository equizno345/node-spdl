import { Spotify } from "./client.js";
import { Endpoints } from "./const.js";
import { parsePlaylist } from "./parser.js";
import { Playlist, PlaylistPage } from "./types.js";
import { getIdFromQuery } from "./url.js";
import { SpotifyApiError, SpotifyError } from "./errors.js";
import undici from "undici";

export class PlaylistClient {
    readonly client: Spotify;
    private static hashes = new Map<string, {value: string; expiresAt: number}>();
    private static pendingHashes = new Map<string, Promise<string>>();

    constructor(client: Spotify) {
        this.client = client;
    }

    /**
     * Gets a playlist metadata.
     * @param query Playlist URL or ID
     * @returns Playlist metadata
     */
    private async rawPage(query: string, offset: number, limit: number): Promise<any> {
        const id = getIdFromQuery(query);
        if (!/^[a-zA-Z0-9]{22}$/.test(id)) throw new SpotifyError("Invalid Spotify playlist");
        // Cookie-issued tokens belong to the web player, not a developer REST app.
        let hash = await this.queryHash();
        let refreshed = false;

            const body = () => ({operationName: "fetchPlaylist", variables: {
                uri: `spotify:playlist:${id}`, offset, limit, enableWatchFeedEntrypoint: false
            }, extensions: {persistedQuery: {version: 1, sha256Hash: hash}}});
            let response: any;
            try {
                response = await this.client.request(Endpoints.QUERY, body());
            } catch (failure) {
                if (!(failure instanceof SpotifyApiError && failure.statusCode === 412)) throw failure;
                response = {errors: [{message: "PersistedQueryNotFound"}]};
            }
            if (response?.errors?.some((error: any) => error.message === "PersistedQueryNotFound") && !refreshed) {
                refreshed = true;
                hash = await this.queryHash(true);
                response = await this.client.request(Endpoints.QUERY, body());
            }
            if (response?.errors?.length) throw new SpotifyError("Spotify could not read this playlist. Please try again later.");
            const playlist = response?.data?.playlistV2;
            if (["NotFound", "GenericError"].includes(playlist?.__typename))
                throw new SpotifyApiError(404, "Spotify playlist was not found or is private");
            const content = playlist?.content;
            if (playlist?.uri !== `spotify:playlist:${id}` || typeof playlist.revisionId !== "string" || !playlist.revisionId ||
                !Array.isArray(content?.items) || !Number.isInteger(content.totalCount) || content.totalCount < 0 || content.totalCount > 10000 ||
                content.pagingInfo?.offset !== offset || content.items.length > limit || content.items.some((item: any) => !item || typeof item !== "object"))
                throw new SpotifyError("Invalid Spotify playlist response");
        return playlist;
    }

    /** One validated web-player page. Persist offset/revision/total to resume without refetching earlier pages. */
    public async getPage(query: string, offset = 0, limit = 100,
        expected?: {snapshotId: string; total: number}): Promise<PlaylistPage> {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            throw new SpotifyError("Invalid Spotify playlist pagination");
        const raw = await this.rawPage(query, offset, limit);
        const total = raw.content.totalCount;
        if (expected && (raw.revisionId !== expected.snapshotId || total !== expected.total))
            throw Object.assign(new SpotifyError("Spotify playlist changed during import. Please refresh again."), {statusCode: 409});
        if (offset > total || offset + raw.content.items.length > total ||
            (offset < total && !raw.content.items.length))
            throw new SpotifyError("Spotify returned an incomplete playlist");
        const itemUids = raw.content.items.map((item: any) => typeof item.uid === "string" ? item.uid : null);
        const uids = itemUids.filter((uid: string | null) => uid !== null);
        if (new Set(uids).size !== uids.length) throw new SpotifyError("Spotify returned an invalid playlist page");
        return {playlist: parsePlaylist(raw), offset, total, itemUids,
            nextOffset: offset + raw.content.items.length < total ? offset + raw.content.items.length : null};
    }

    public async get(query: string): Promise<Playlist> {
        const first = await this.getPage(query);
        const tracks = [...first.playlist.tracks], uids = first.itemUids.filter(uid => uid !== null);
        let next = first.nextOffset, pages = 1;
        while (next !== null) {
            if (pages++ >= 200) throw new SpotifyError("Spotify returned an incomplete playlist");
            const page = await this.getPage(query, next, 100, {snapshotId: first.playlist.snapshotId!, total: first.total});
            tracks.push(...page.playlist.tracks);
            uids.push(...page.itemUids.filter(uid => uid !== null));
            next = page.nextOffset;
        }
        if (new Set(uids).size !== uids.length) throw new SpotifyError("Spotify returned an invalid playlist page");
        if (pages > 1) await this.getPage(query, 0, 1, {snapshotId: first.playlist.snapshotId!, total: first.total});
        return {...first.playlist, tracks};
    }

    /** Shared discovery for the existing web-player metadata methods. */
    public async queryHash(force = false, operation: "fetchPlaylist" | "getTrack" | "accountAttributes" | "profileAttributes" = "fetchPlaylist"): Promise<string> {
        const cached = PlaylistClient.hashes.get(operation);
        if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
        const pending = PlaylistClient.pendingHashes.get(operation);
        if (pending) return pending;
        const request = (async () => {
            // Inspect public assets as text; never send account credentials or execute JS.
            const text = async (url: string) => {
                const response = await undici.fetch(url, {headers: {"User-Agent": this.client.getHeaders()["User-Agent"]},
                    redirect: "error", signal: AbortSignal.timeout(15000)});
                if (!response.ok) {
                    await response.body?.cancel();
                    throw new SpotifyError("Spotify web player metadata is temporarily unavailable");
                }
                const chunks: Buffer[] = [];
                let length = 0;
                const reader = response.body?.getReader();
                if (!reader) throw new SpotifyError("Spotify web player metadata is temporarily unavailable");
                while (true) {
                    const {done, value} = await reader.read();
                    if (done) break;
                    length += value.length;
                    if (length > 8 * 1024 * 1024) {
                        await reader.cancel();
                        throw new SpotifyError("Spotify web player metadata is temporarily unavailable");
                    }
                    chunks.push(Buffer.from(value));
                }
                return Buffer.concat(chunks).toString("utf8");
            };
            const html = await text(Endpoints.HOME_PAGE);
            const bundle = html.match(/https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/web-player\.[a-f0-9]+\.js/)?.[0];
            if (!bundle) throw new SpotifyError("Spotify web player metadata is temporarily unavailable");
            const source = await text(bundle);
            const hash = source.match(new RegExp(`"${operation}","query","([a-f0-9]{64})"`))?.[1];
            if (!hash) throw new SpotifyError("Spotify web player metadata is temporarily unavailable");
            PlaylistClient.hashes.set(operation, {value: hash, expiresAt: Date.now() + 3600000});
            return hash;
        })();
        PlaylistClient.pendingHashes.set(operation, request);
        try {return await request;}
        finally {PlaylistClient.pendingHashes.delete(operation);}
    }
}
