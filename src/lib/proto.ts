import path from "node:path";
import { fileURLToPath } from "node:url";
import proto from "protobufjs";

export const resolveProto = async (
    buffer: Buffer, 
    file: string,
    message: string
): Promise<any> => {
    const root: proto.Root = await proto.load(
        path.resolve(`./proto/${file}.proto`)
    );

    const messageType = root.lookupType(message);
    const decodedMessage = messageType.decode(buffer);

    return messageType.toObject(decodedMessage, {
        longs: String,
        enums: String,
        bytes: String
    });
}

const resolveProtoPath = (filename: string): string => {
    // Prefer the module URL: CommonJS callers can expose a global __dirname to ESM.
    if (import.meta.url) {
        return path.join(path.dirname(fileURLToPath(import.meta.url)), "../proto", filename);
    }
    return path.join(__dirname, "../proto", filename);
}

const playplay = proto.loadSync(resolveProtoPath("playplay.proto"));

export const PlayPlayLicenseRequest = playplay.lookupType("PlayPlayLicenseRequest");
export const Interactivity = playplay.lookupEnum("Interactivity");
export const ContentType = playplay.lookupEnum("ContentType");
export const PlayPlayLicenseResponse = playplay.lookupType("PlayPlayLicenseResponse");

// Wire-compatible subset of Spotify's extended-metadata/audio-files protocol.
// Field numbers: librespot-org/librespot protocol/proto/{extended_metadata,
// entity_extension_data,audio_files_extension,metadata}.proto.
const audioMetadata = proto.parse(`syntax = "proto3";
message AudioFilesQuery { int32 extension_kind = 1; }
message AudioFilesEntityRequest { string entity_uri = 1; repeated AudioFilesQuery query = 2; }
message AudioFilesBatchRequest { repeated AudioFilesEntityRequest entity_request = 2; }
message AudioFilesAny { string type_url = 1; bytes value = 2; }
message AudioFilesEntryHeader { int32 status_code = 1; }
message AudioFilesEntry { AudioFilesEntryHeader header = 1; string entity_uri = 2; AudioFilesAny extension_data = 3; }
message AudioFilesProviderHeader { int32 provider_error_status = 1; }
message AudioFilesExtension { AudioFilesProviderHeader header = 1; int32 extension_kind = 2; repeated AudioFilesEntry extension_data = 3; }
message AudioFilesBatchResponse { repeated AudioFilesExtension extended_metadata = 2; }
message AudioFile { bytes file_id = 1; int32 format = 2; }
message ExtendedAudioFile { AudioFile file = 1; int32 average_bitrate = 4; }
message AudioFilesResponse { repeated ExtendedAudioFile files = 1; }
`).root;
export const AudioFilesBatchRequest = audioMetadata.lookupType("AudioFilesBatchRequest");
export const AudioFilesBatchResponse = audioMetadata.lookupType("AudioFilesBatchResponse");
export const AudioFilesResponse = audioMetadata.lookupType("AudioFilesResponse");
