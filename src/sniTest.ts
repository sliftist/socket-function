import { parseSNIExtension, parseTLSHello, SNIType } from "./tlsParsing";

let tlsExtensionLookup: { [type: number]: string } = {
    0: "server_name",
    1: "max_fragment_length",
    2: "client_certificate_url",
    3: "trusted_ca_keys",
    4: "truncated_hmac",
    5: "status_request",
    6: "user_mapping",
    7: "client_authz",
    8: "server_authz",
    9: "cert_type",
    10: "supported_groups",
    11: "ec_point_formats",
    12: "srp",
    13: "signature_algorithms",
    14: "use_srtp",
    15: "heartbeat",
    16: "application_layer_protocol_negotiation",
    17: "status_request_v2",
    18: "signed_certificate_timestamp",
    19: "client_certificate_type",
    20: "server_certificate_type",
    21: "padding",
    22: "encrypt_then_mac",
    23: "extended_master_secret",
    24: "token_binding",
    25: "cached_info",
    26: "tls_lts",
    27: "compress_certificate",
    28: "record_size_limit",
    29: "pwd_protect",
    30: "pwd_clear",
    31: "password_salt",
    32: "ticket_pinning",
    33: "tls_cert_with_extern_psk",
    34: "delegated_credential",
    35: "session_ticket",
    36: "TLMSP",
    37: "TLMSP_proxying",
    38: "TLMSP_delegate",
    39: "supported_ekt_ciphers",
    40: "Reserved",
    41: "pre_shared_key",
    42: "early_data",
    43: "supported_versions",
    44: "cookie",
    45: "psk_key_exchange_modes",
    46: "Reserved",
    47: "certificate_authorities",
    48: "oid_filters",
    49: "post_handshake_auth",
    50: "signature_algorithms_cert",
    51: "key_share",
    52: "transparency_info",
    53: "connection_id",
    54: "connection_id",
    55: "external_id_hash",
    56: "external_session_id",
    57: "quic_transport_parameters",
    58: "ticket_request",
    59: "dnssec_chain",
    60: "sequence_number_encryption_algorithms",
    61: "rrc",
    2570: "encrypted_client_hello?",
    17513: "application_settings",
    6682: "generated_random_extensions_and_sustain_extensibility",
    10794: "generated_random_extensions_and_sustain_extensibility",
    14906: "generated_random_extensions_and_sustain_extensibility",
    19018: "generated_random_extensions_and_sustain_extensibility",
    23130: "generated_random_extensions_and_sustain_extensibility",
    27242: "generated_random_extensions_and_sustain_extensibility",
    31354: "generated_random_extensions_and_sustain_extensibility",
    35466: "generated_random_extensions_and_sustain_extensibility",
    39578: "generated_random_extensions_and_sustain_extensibility",
    43690: "generated_random_extensions_and_sustain_extensibility",
    47802: "generated_random_extensions_and_sustain_extensibility",
    51914: "generated_random_extensions_and_sustain_extensibility",
    56026: "generated_random_extensions_and_sustain_extensibility",
    60138: "generated_random_extensions_and_sustain_extensibility",
    64250: "generated_random_extensions_and_sustain_extensibility",
    65037: "encrypted_client_hello",
    65281: "renegotiation_info" // 0xFF01
};

async function main() {
    const packet = Buffer.from(
        `FgMBBwgBAAcEAwNWbpKnOzI9CRp2ESvA5QzCXg5FYncEObckUkNoG3+/DyAwI4HL0havBXKvPlJtZJBgtZ+I/FqBlKGek8NGJcgdqQAgiooTARMCEwPAK8AvwCzAMMypzKjAE8AUAJwAnQAvADUBAAabSkoAAAAbAAMCAAIACgAMAArq6mOZAB0AFwAYAAUABQEAAAAAAC0AAgEB/wEAAQAAIwAAAAsAAgEAABIAAAANABIAEAQDCAQEAQUDCAUFAQgGBgEAFwAA/g0AugAAAQABCwAgIRJsXQHGN5cbIp9ucgXJ824RS/6hqIikNiMKw7/gsDAAkK8j0YYXYsSnpX4siEVnB/AxzQCPaGMoT4y1i63f4mzV0Sa6puc4sZqkxY7TyQMJLrGPL00HaJZh6ReT/ggPbCwg5f5/2hUCdZSx4aUpYMb7lAx9VVJjhrquZIRRVrk8yV0OjEivreTN02u1mgIgMY/0P8RzOea+iQluEF9ASOYxgNIU20xoKK608ktQrTafSQAQAAsACQhodHRwLzEuMQAzBO8E7erqAAEAY5kEwB8fuK+qumVLi67+BmQ5uQ556Opa122UZFmnfuoKQY1tiXkzM7Z+wmWOLTg7l3Ncu8ECL/Z9G6ZLP4N5OKGjiHE307sEvNRqdEnFYoQMVotF6hNbt3F4GrEBa6CuCEohg9HKg3RtIfMFYNc1lDC4rJCLwNETijo5MlOFnYVGpWOMcBZbdLsGv5JxN7idRUGvxsttaya3GYxSI1yFW9dZaysTsYXA2IzPp7M950GkJzBK5Zy3wBiXoZYGYKJGy5EA1XIE88Y6X2VNghPIatHHjdav+PpsLZCyUowEsAN49gh/yRrBNZxo6gNbfOIds/UpjlYtIEo1lch2ygWzVLS55qxm35IQUVKQjEQiPDNUI6g9RZZD+VSH5vB1ouMwTqbDAAN9EsUxigYmQggjz1jGFEm+DecEQTkXoQOIwWsAq+M39Eq7M3CwYVQ6yDQI+rQD9xxin8I9PrdVoXGaTVwnY9GFKFCYZyewSGeuPGSaPcdKwvBb/IgfFVRt2aU24XNmFsCkgLSzHEkBg1uYqjd+uIY7zTWo5WIevniL4SCIvRyvTQB7DICAZ+BxSUxio9x19OWQCitnoXdoGGwuTIQqSYuimFBedKa2b4Yk3nkPIRqa3jldbGMRwQmpaQFnsOJml/pEr3sQIuEcQ2shaIuqW+Zo86yamflqpCmCbQWNiipRYwQ/AmG7oOeS1iJomPiRJDwVNaoDZzI2ApYIcQckNPNrI9qOrGwww6x1T9EwKadz/1OcHQcbWtej5QkLm5Ss/9paxqYsu1kuohlvPOSd4txqKOGNvOhzxqqOweZ7p8l/H/JhnMkEUCZYvOW4JhthXsYMfnWn8rciE7KuMskf65mqI1tI5SZqzxAfH4MidyUJRNwR6mwWUgzMi7kB3eM3IPUbCDpUIpQBipt2SyenIMXNH9ZjnYtdCwVDe7m6mshYAJVV7oJDw5yn2pYH5nsZ+gM93vNWBvZVQjZZmRdZQ2YqhKaUyQgpOEhlE1w7XAXJp+um2kA5qElw9sNbxvOziNSPLyi17xgy1CSBSzB+o8JAfZamxUHFXEGSRYoR8qekMnlJeVRXlojEoaxMsspFX3itMOqIHNUL9Nltswaqggu7s+NQfshoLEg5gkfM/tok4sISLZlX7ACgcWZBQudMPTyn3FsQIbzNgXBzWTdiCZg9iZttoJtX8FygYbzEF9kFJyc5fIBA4NACVZhOf+onlMcFEbHCu6ilqMuzwQxf6vgV`
            .replace(/\s/g, "")
        , "base64"
    );

    let data = parseTLSHello(packet);
    let sni = data.extensions.filter(x => x.type === SNIType).flatMap(x => parseSNIExtension(x.data))[0];
    console.log(`Packet size ${packet.byteLength}, missing bytes ${data.missingBytes}`);
    for (let ext of data.extensions) {
        console.log(`Extension: ${tlsExtensionLookup[ext.type] || ext.type}, bytes length: ${ext.data.length}`);
    }
}
main().catch(e => console.error(e)).finally(() => process.exit());