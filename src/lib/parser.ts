import {
	Album, 
	Artist, 
	ColorLyrics, 
	Episode, 
	EpisodeMetadata, 
	MetadataReference, 
	Playlist, 
	PlaylistTrack, 
	Podcast, 
	SelfUser, 
	Track, 
	TrackFile, 
	TrackMetadata, 
	User
} from "./types";

export const parseAlbum = (payload: Record<string, any>): Album => {
    payload = payload || {};
    const album: Album = {
		id: payload["id"],
		uri: payload["uri"],
		externalUrl: payload["external_urls"]?.["spotify"] || "",
		name: payload["name"] || "",
		releaseDate: new Date(payload["release_date"]),
		images: payload["images"] || payload["coverArt"]?.["sources"] || [],
		availableMarkets: payload["availableMarkets"],
		artists: (Array.isArray(payload["artists"]) ? payload["artists"] : payload["artists"]?.["items"] || []).map(parseArtist),
		tracks: (Array.isArray(payload["tracks"]) ? payload["tracks"] : payload["tracks"]?.["items"] || []).map(parseTrack),
		label: payload["label"],
		genres: payload["genres"],
		copyright: payload["copyrights"],
		popularity: payload["popularity"]
	}

	return album;
}

export const parseArtist = (payload: Record<string, any>): Artist => {
    payload = payload || {};
	const artist: Artist = {
		id: payload["id"] || payload["uri"]?.split(":").pop() || "",
		uri: payload["uri"],
		externalUrl: payload["external_urls"]?.["spotify"] || "",
		name: payload["name"] || payload["profile"]?.["name"] || "",
		images: payload["images"],
		popularity: payload["popularity"] || 0,
		followers: payload["followers"]?.["total"] || 0,
		genres: payload["genres"]
	}

	return artist;
}

export const parseEpisode = (payload: Record<string, any>): Episode => {
	const episode: Episode = {
		id: payload["id"],
		uri: payload["uri"],
		externalUrl: payload["external_urls"]["spotify"],
		name: payload["name"],
		description: payload["description"],
		previewUrl: payload["audio_preview_url"],
		durationMs: payload["duration_ms"],
		images: payload["images"],
		isPlayable: payload["is_playable"] || true,
		languages: payload["languages"],
		releaseDate: new Date(payload["release_date"]),
		explicit: payload["explicit"] || false,
		restrictions: payload["restrictions"] || {},
		podcast: parsePodcast(payload["show"])
	}

	return episode;
}

export const parseEpisodeMetadata = (payload: Record<string, any>): EpisodeMetadata => {
    const episode: EpisodeMetadata = {
		gid: payload["gid"],
		name: payload["name"],
		files: payload["audio"] ? payload["audio"].map(parseTrackFile) : payload["alternative"]["audio"].map(parseTrackFile),
		preview: payload["audio_preview"].map(parseTrackFile),
		description: payload["description"],
		explicit: payload["explicit"] || false,
		language: payload["language"],
		externalUrl: payload["external_url"],
		restriction: payload["restriction"]
    };

    return episode;
}

export const parseLyrics = (payload: Record<string, any>): ColorLyrics => {
	const lyrics: ColorLyrics = {
		lyrics: payload["lines"],
		colors: payload["colors"]
	}

	return lyrics;
}

export const parsePlaylist = (payload: Record<string, any>): Playlist => {
	const content = payload["content"];
	const id = payload["id"] || payload["uri"]?.split(":").pop() || "";
	const playlist: Playlist = {
		id,
		uri: payload["uri"],
		externalUrl: payload["external_urls"]?.["spotify"] || `https://open.spotify.com/playlist/${id}`,
		name: payload["name"],
		description: payload["description"],
		tracks: (content?.items || payload["tracks"]?.["items"] || payload["items"]?.["items"] || []).map(parsePlaylistTrack),
		collaborative: payload["collaborative"],
		followers: payload["followers"]?.["total"] || 0,
		images: Array.isArray(payload["images"]) ? payload["images"] : payload["images"]?.["items"]?.[0]?.["sources"] || [],
		owner: parseUser(payload["owner"] || payload["ownerV2"]?.["data"] || {}),
		public: payload["public"] || false,
		snapshotId: payload["snapshot_id"] || payload["revisionId"]
	}

	return playlist;
}

export const parsePlaylistTrack = (payload: Record<string, any>): PlaylistTrack => {
	const track: PlaylistTrack = {
		...parseTrack(payload),
		addedAt: new Date(payload["added_at"] || payload["addedAt"]?.["isoString"] || 0),
		addedBy: parseUser(payload["added_by"] || payload["addedBy"]?.["data"] || {}),
	}

	return track;
}

export const parsePodcast = (payload: Record<string, any>): Podcast => {
	const podcast: Podcast = {
		id: payload["id"],
		uri: payload["uri"],
		externalUrl: payload["external_urls"]["spotify"],
		episodes: payload["episodes"]["items"].map(parseEpisode),
		name: payload["name"],
		publisher: payload["publisher"],
		description: payload["description"] || payload["html_description"],
		copyrights: payload["copyrights"],
		availableMarkets: payload["available_markets"],
		languages: payload["languages"],
		explicit: payload["explicit"]
	}

	return podcast;
}

export const parseReference = (payload: Record<string, any>): MetadataReference => {
	const ref: MetadataReference = {
		gid: payload["gid"]
	}

	if (payload["name"]) ref.name = payload["name"];
	return ref;
}

export const parseSelfUser = (payload: Record<string, any>): SelfUser => {
	const user: SelfUser = {
		id: payload["id"],
		uri: payload["uri"],
		externalUrl: payload["external_urls"]["spotify"],
		displayName: payload["display_name"] || payload["id"],
		country: payload["country"],
		email: payload["email"],
		followers: payload["followers"]["total"],
		images: payload["images"],
		product: payload["product"]
	}

	return user;
}

export const parseTrack = (payload: Record<string, any>): Track => {
	const wrapper = payload?.["itemV2"];
	if (wrapper) payload = wrapper.data || {};
	else if (payload && ("track" in payload || "item" in payload)) payload = payload.track || payload.item || {};
	payload = payload || {};
	const uri = payload["uri"] || wrapper?._uri || "";
	const id = payload["id"] || uri.match(/^spotify:track:([a-zA-Z0-9]{22})$/)?.[1] || "";
	const local = payload["is_local"] === true || uri.startsWith("spotify:local:");
	const isTrack = payload["type"] === "track" || payload["__typename"] === "Track";
	const track: Track = {
		id,
		uri,
		externalUrl: payload["external_urls"]?.["spotify"] || (id ? `https://open.spotify.com/track/${id}` : ""),
		name: payload["name"] || "Unavailable Spotify item",
		availableMarkets: payload["available_markets"],
		artists: (Array.isArray(payload["artists"]) ? payload["artists"] : payload["artists"]?.["items"] || payload["artist"] || []).map(parseArtist),
		album: parseAlbum(payload["album"] || payload["albumOfTrack"] || {}),
		popularity: payload["popularity"],
		previewUrl: payload["preview_url"],
		trackNumber: payload["track_number"],
		discNumber: payload["disc_number"],
		durationMs: Number(payload["duration_ms"] || payload["trackDuration"]?.["totalMilliseconds"]) || 0,
		isLocal: local,
		isPlayable: !!id && isTrack && !local && !payload["restrictions"]?.["reason"] &&
			(payload["playability"] ? payload["playability"].playable === true : payload["is_playable"] !== false),
		explicit: payload["explicit"] || false
	}

	return track;
}

export const parseTrackFile = (payload: Record<string, any>): TrackFile => {
	const track: TrackFile = {
 		fileId: payload["file_id"],
		format: payload["format"]
	}

	return track;
}

export const parseTrackMetadata = (payload: Record<string, any>): TrackMetadata => {
    const track: TrackMetadata = {
		gid: payload["gid"],
		name: payload["name"],
		album: payload["album"],
		files: payload["file"] ? payload["file"].map(parseTrackFile) : payload["alternative"][0]["file"].map(parseTrackFile),
		preview: payload["preview"] ? payload["preview"].map(parseTrackFile) : payload["alternative"][0]["preview"].map(parseTrackFile),
		hasLyrics: payload["has_lyrics"] || false,
		languages: payload["languages"],
		restriction: payload["restriction"]
    };
	
    return track;
}

export const parseUser = (payload: Record<string, any>): User => {
	const user: User = {
		id: payload["id"],
		uri: payload["uri"],
		externalUrl: payload["external_urls"]?.["spotify"] || "",
		displayName: payload["display_name"] || payload["name"] || payload["id"] || ""
	}

	return user;
}
