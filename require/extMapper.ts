export function getExtContentType(ext: string): string {
    // Images
    if (ext === ".svg") return "image/svg+xml";
    if (ext === ".ico") return "image/x-icon";
    if (ext === ".png") return "image/png";
    if (ext === ".jpg") return "image/jpeg";
    if (ext === ".jpeg") return "image/jpeg";
    if (ext === ".gif") return "image/gif";
    if (ext === ".webp") return "image/webp";
    if (ext === ".avif") return "image/avif";
    if (ext === ".heic") return "image/heic";
    if (ext === ".heif") return "image/heif";
    if (ext === ".bmp") return "image/bmp";
    if (ext === ".tiff") return "image/tiff";
    if (ext === ".tif") return "image/tiff";
    if (ext === ".jxl") return "image/jxl";

    // Audio
    if (ext === ".mp3") return "audio/mpeg";
    if (ext === ".wav") return "audio/wav";
    if (ext === ".ogg") return "audio/ogg";
    if (ext === ".m4a") return "audio/mp4";
    if (ext === ".aac") return "audio/aac";
    if (ext === ".flac") return "audio/flac";
    if (ext === ".wma") return "audio/x-ms-wma";
    if (ext === ".opus") return "audio/opus";

    // Video
    if (ext === ".mp4") return "video/mp4";
    if (ext === ".webm") return "video/webm";
    if (ext === ".mkv") return "video/x-matroska";
    if (ext === ".avi") return "video/x-msvideo";
    if (ext === ".mov") return "video/quicktime";
    if (ext === ".wmv") return "video/x-ms-wmv";
    if (ext === ".flv") return "video/x-flv";
    if (ext === ".m4v") return "video/x-m4v";

    // Web files
    if (ext === ".html") return "text/html";
    if (ext === ".htm") return "text/html";
    if (ext === ".css") return "text/css";
    if (ext === ".js") return "text/javascript";
    if (ext === ".mjs") return "text/javascript";
    if (ext === ".json") return "application/json";
    if (ext === ".xml") return "application/xml";
    if (ext === ".rss") return "application/rss+xml";
    if (ext === ".atom") return "application/atom+xml";

    // Documents
    if (ext === ".pdf") return "application/pdf";
    if (ext === ".doc") return "application/msword";
    if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (ext === ".xls") return "application/vnd.ms-excel";
    if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (ext === ".ppt") return "application/vnd.ms-powerpoint";
    if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    if (ext === ".odt") return "application/vnd.oasis.opendocument.text";
    if (ext === ".ods") return "application/vnd.oasis.opendocument.spreadsheet";
    if (ext === ".odp") return "application/vnd.oasis.opendocument.presentation";
    if (ext === ".rtf") return "application/rtf";

    // Text files
    if (ext === ".txt") return "text/plain";
    if (ext === ".md") return "text/markdown";
    if (ext === ".csv") return "text/csv";
    if (ext === ".log") return "text/plain";

    // Programming files
    if (ext === ".ts") return "text/typescript";
    if (ext === ".tsx") return "text/typescript";
    if (ext === ".jsx") return "text/javascript";
    if (ext === ".py") return "text/x-python";
    if (ext === ".java") return "text/x-java-source";
    if (ext === ".c") return "text/x-c";
    if (ext === ".cpp") return "text/x-c++";
    if (ext === ".h") return "text/x-c";
    if (ext === ".hpp") return "text/x-c++";
    if (ext === ".cs") return "text/x-csharp";
    if (ext === ".php") return "text/x-php";
    if (ext === ".rb") return "text/x-ruby";
    if (ext === ".go") return "text/x-go";
    if (ext === ".rs") return "text/x-rust";
    if (ext === ".swift") return "text/x-swift";
    if (ext === ".kt") return "text/x-kotlin";
    if (ext === ".scala") return "text/x-scala";
    if (ext === ".sh") return "text/x-shellscript";
    if (ext === ".bat") return "text/x-msdos-batch";
    if (ext === ".ps1") return "text/x-powershell";

    // Archives
    if (ext === ".zip") return "application/zip";
    if (ext === ".rar") return "application/vnd.rar";
    if (ext === ".tar") return "application/x-tar";
    if (ext === ".gz") return "application/gzip";
    if (ext === ".bz2") return "application/x-bzip2";
    if (ext === ".7z") return "application/x-7z-compressed";
    if (ext === ".xz") return "application/x-xz";

    // Fonts
    if (ext === ".ttf") return "font/ttf";
    if (ext === ".otf") return "font/otf";
    if (ext === ".woff") return "font/woff";
    if (ext === ".woff2") return "font/woff2";
    if (ext === ".eot") return "application/vnd.ms-fontobject";

    // Other common formats
    if (ext === ".epub") return "application/epub+zip";
    if (ext === ".mobi") return "application/x-mobipocket-ebook";
    if (ext === ".apk") return "application/vnd.android.package-archive";
    if (ext === ".dmg") return "application/x-apple-diskimage";
    if (ext === ".iso") return "application/x-iso9660-image";
    if (ext === ".exe") return "application/x-msdownload";
    if (ext === ".msi") return "application/x-msi";
    if (ext === ".deb") return "application/x-debian-package";
    if (ext === ".rpm") return "application/x-rpm";

    console.warn(`Unknown extension, ${ext}`);
    return "text/plain";
}

export function getContentTypeFromBuffer(buffer: Buffer): string | undefined {
    if (buffer.length < 4) return undefined;

    // Helper function to check if buffer starts with specific bytes
    const startsWith = (bytes: number[]): boolean => {
        if (buffer.length < bytes.length) return false;
        for (let i = 0; i < bytes.length; i++) {
            if (buffer[i] !== bytes[i]) return false;
        }
        return true;
    };

    // Helper function to check bytes at specific offset
    const hasAtOffset = (offset: number, bytes: number[]): boolean => {
        if (buffer.length < offset + bytes.length) return false;
        for (let i = 0; i < bytes.length; i++) {
            if (buffer[offset + i] !== bytes[i]) return false;
        }
        return true;
    };

    // Images
    if (startsWith([0xFF, 0xD8, 0xFF])) return "image/jpeg";
    if (startsWith([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return "image/png";
    if (startsWith([0x47, 0x49, 0x46, 0x38])) return "image/gif";
    if (startsWith([0x42, 0x4D])) return "image/bmp";
    if (startsWith([0x49, 0x49, 0x2A, 0x00]) || startsWith([0x4D, 0x4D, 0x00, 0x2A])) return "image/tiff";
    if (startsWith([0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
    if (buffer.toString("ascii", 0, 4) === "<svg" || buffer.toString("ascii", 0, 5) === "<?xml") {
        if (buffer.toString("utf8").includes("<svg")) return "image/svg+xml";
    }

    // WebP and modern image formats
    if (startsWith([0x52, 0x49, 0x46, 0x46]) && hasAtOffset(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
    if (hasAtOffset(4, [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])) return "image/avif";
    if (hasAtOffset(4, [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])) return "image/heic";
    if (hasAtOffset(4, [0x66, 0x74, 0x79, 0x70, 0x6D, 0x69, 0x66, 0x31])) return "image/heif";

    // Audio
    if (startsWith([0xFF, 0xFB]) || startsWith([0xFF, 0xF3]) || startsWith([0xFF, 0xF2])) return "audio/mpeg";
    if (startsWith([0x49, 0x44, 0x33])) return "audio/mpeg"; // MP3 with ID3
    if (startsWith([0x52, 0x49, 0x46, 0x46]) && hasAtOffset(8, [0x57, 0x41, 0x56, 0x45])) return "audio/wav";
    if (startsWith([0x4F, 0x67, 0x67, 0x53])) return "audio/ogg";
    if (startsWith([0x66, 0x4C, 0x61, 0x43])) return "audio/flac";
    if (hasAtOffset(4, [0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41])) return "audio/mp4";

    // Video
    if (hasAtOffset(4, [0x66, 0x74, 0x79, 0x70])) {
        const ftyp = buffer.toString("ascii", 8, 12);
        if (ftyp.startsWith("mp4") || ftyp.startsWith("isom") || ftyp.startsWith("M4V")) return "video/mp4";
        if (ftyp.startsWith("qt")) return "video/quicktime";
    }
    if (startsWith([0x1A, 0x45, 0xDF, 0xA3])) return "video/webm"; // Also mkv
    if (startsWith([0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11])) return "video/x-ms-wmv";
    if (startsWith([0x46, 0x4C, 0x56, 0x01])) return "video/x-flv";
    if (startsWith([0x52, 0x49, 0x46, 0x46]) && hasAtOffset(8, [0x41, 0x56, 0x49, 0x20])) return "video/x-msvideo";

    // Documents
    if (startsWith([0x25, 0x50, 0x44, 0x46])) return "application/pdf";
    if (startsWith([0x50, 0x4B, 0x03, 0x04]) || startsWith([0x50, 0x4B, 0x05, 0x06]) || startsWith([0x50, 0x4B, 0x07, 0x08])) {
        // ZIP-based formats - need to check internal structure
        const content = buffer.toString("ascii", 30, 100);
        if (content.includes("word/")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (content.includes("xl/")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (content.includes("ppt/")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if (content.includes("META-INF/")) {
            if (content.includes("content.xml")) return "application/vnd.oasis.opendocument.text";
        }
        return "application/zip";
    }
    if (startsWith([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])) {
        // Microsoft Office legacy formats
        return "application/msword"; // Could also be Excel or PowerPoint
    }
    if (startsWith([0x7B, 0x5C, 0x72, 0x74, 0x66])) return "application/rtf";

    // Archives
    if (startsWith([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07])) return "application/vnd.rar";
    if (startsWith([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])) return "application/x-7z-compressed";
    if (startsWith([0x1F, 0x8B])) return "application/gzip";
    if (startsWith([0x42, 0x5A, 0x68])) return "application/x-bzip2";
    if (startsWith([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00])) return "application/x-xz";
    if (startsWith([0x75, 0x73, 0x74, 0x61, 0x72])) return "application/x-tar";

    // Executables
    if (startsWith([0x4D, 0x5A])) return "application/x-msdownload"; // Windows PE
    if (startsWith([0x7F, 0x45, 0x4C, 0x46])) return "application/x-executable"; // Linux ELF
    if (startsWith([0xCA, 0xFE, 0xBA, 0xBE]) || startsWith([0xFE, 0xED, 0xFA, 0xCE])) return "application/x-mach-binary"; // macOS binary
    if (startsWith([0x50, 0x4B, 0x03, 0x04]) && buffer.toString("ascii", 30, 50).includes("AndroidManifest.xml")) return "application/vnd.android.package-archive";

    // Fonts
    if (startsWith([0x00, 0x01, 0x00, 0x00])) return "font/ttf";
    if (startsWith([0x4F, 0x54, 0x54, 0x4F])) return "font/otf";
    if (startsWith([0x77, 0x4F, 0x46, 0x46])) return "font/woff";
    if (startsWith([0x77, 0x4F, 0x46, 0x32])) return "font/woff2";

    // Web files (text-based, check for common patterns)
    const textStart = buffer.toString("utf8", 0, Math.min(100, buffer.length)).toLowerCase();
    if (textStart.includes("<!doctype html") || textStart.includes("<html")) return "text/html";
    if (textStart.includes("<?xml")) return "application/xml";
    if (textStart.startsWith("{") || textStart.startsWith("[")) {
        try {
            JSON.parse(buffer.toString("utf8"));
            return "application/json";
        } catch {
            // Not JSON
        }
    }

    // Other formats
    if (startsWith([0x25, 0x21, 0x50, 0x53])) return "application/postscript";
    if (startsWith([0x38, 0x42, 0x50, 0x53])) return "image/vnd.adobe.photoshop";
    if (startsWith([0x49, 0x49, 0x2A, 0x00, 0x10, 0x00, 0x00, 0x00, 0x43, 0x52])) return "image/x-canon-cr2";

    return undefined;
}