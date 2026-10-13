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