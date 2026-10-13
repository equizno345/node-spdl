import { Spotify } from "./client.js";
import { Endpoints } from "./const.js";
import { parseLyrics, parseTrack, parseTrackMetadata } from "./parser.js";
import { ColorLyrics, Track, TrackMetadata } from "./types.js";
import { getIdFromQuery } from "./url.js";
import { SpotifyApiError, SpotifyError } from "./errors.js";

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

    public async getMetadata(gid: string): Promise<TrackMetadata> {
        const meta = await this.client.request(`${Endpoints.TRACK_METADATA}${gid}`); 
        return parseTrackMetadata(meta);
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
