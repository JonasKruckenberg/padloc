import { Base64String, stringToBase64, base64ToString, marshal, unmarshal, Marshalable } from "./encoding";
import { Storable, Storage } from "./storage";

// Minimum number of pbkdf2 iterations
const PBKDF2_ITER_MIN = 1e4;
// Default number of pbkdf2 iterations
const PBKDF2_ITER_DEFAULT = 5e4;
// Maximum number of pbkdf2 iterations
const PBKDF2_ITER_MAX = 1e7;

export type CipherText = Base64String;
export type PlainText = Base64String;

// Available Symmetric Key Sizes
export type KeySize = 128 | 192 | 256;
// Available authentication tag sizes
export type TagSize = 64 | 96 | 128;

export type SymmetricKey = Base64String;
export type PublicKey = Base64String;
export type PrivateKey = Base64String;

export type Key = SymmetricKey | PublicKey | PrivateKey;

export type CipherType = "symmetric" | "asymmetric";

export interface BaseCipherParams {
    cipherType: CipherType;
    algorithm: string;
}

export interface SymmetricCipherParams extends BaseCipherParams {
    cipherType: "symmetric";
    algorithm: "AES-GCM" | "AES-CCM";
    tagSize: TagSize;
    keySize: KeySize;
    iv?: Base64String;
    additionalData?: Base64String;
}

export interface AsymmetricCipherParams extends BaseCipherParams {
    cipherType: "asymmetric";
    algorithm: "RSA-OAEP";
}

export type CipherParams = SymmetricCipherParams | AsymmetricCipherParams;

export interface KeyDerivationParams {
    algorithm: "PBKDF2";
    hash: "SHA-256" | "SHA-512";
    keySize: KeySize;
    iterations: number;
    salt?: string;
}

export interface WrapKeyParams {
    algorithm: "RSA-OAEP";
}

export interface CryptoProvider {
    isAvailable(): boolean;
    randomBytes(n: number): Base64String;
    randomKey(n: KeySize): Promise<SymmetricKey>;
    deriveKey(password: string, params: KeyDerivationParams): Promise<SymmetricKey>;
    encrypt(key: Key, data: PlainText, params: CipherParams): Promise<CipherText>;
    decrypt(key: Key, data: Base64String, params: CipherParams): Promise<PlainText>;
    generateKeyPair(): Promise<{ privateKey: PrivateKey; publicKey: PublicKey }>;
}

export class CryptoError {
    constructor(
        public code:
            | "invalid_container_data"
            | "unsupported_container_version"
            | "invalid_cipher_params"
            | "invalid_key_params"
            | "decryption_failed"
            | "encryption_failed"
            | "not_supported"
    ) {}
}

export function validateCipherParams(params: any): CipherParams {
    switch (params.cipherType) {
        case "symmetric":
            if (
                !["AES-GCM", "AES-CCM"].includes(params.algorithm) ||
                // TODO: validate base 64
                !params.iv ||
                typeof params.iv !== "string" ||
                !params.additionalData ||
                typeof params.additionalData !== "string" ||
                !params.tagSize ||
                ![64, 96, 128].includes(params.tagSize)
            ) {
                throw new CryptoError("invalid_cipher_params");
            }
            break;
        case "asymmetric":
            if (params.algorithm !== "RSA-OAEP") {
                throw new CryptoError("invalid_cipher_params");
            }
            break;
        default:
            throw new CryptoError("invalid_cipher_params");
    }

    return params as CipherParams;
}

export function defaultKeyDerivationParams(): KeyDerivationParams {
    return {
        algorithm: "PBKDF2",
        hash: "SHA-256",
        keySize: 256,
        iterations: PBKDF2_ITER_DEFAULT
    };
}

export function validateKeyDerivationParams(params: any): KeyDerivationParams {
    if (
        params.algorithm !== "PBKDF2" ||
        !params.salt ||
        typeof params.salt !== "string" ||
        !params.iterations ||
        params.iterations < PBKDF2_ITER_MIN ||
        params.iterations > PBKDF2_ITER_MAX ||
        ![192, 256, 512].includes(params.keySize) ||
        !["SHA-256", "SHA-512"].includes(params.hash)
    ) {
        throw new CryptoError("invalid_key_params");
    }

    return params as KeyDerivationParams;
}

export type EncryptionScheme = "simple" | "PBES2" | "shared";

export interface BaseRawContainer {
    version: 2;
    scheme: EncryptionScheme;
    id: string;
    ep: SymmetricCipherParams;
    ct: CipherText;
}

export interface SimpleRawContainer extends BaseRawContainer {
    scheme: "simple";
}

export interface PasswordBasedRawContainer extends BaseRawContainer {
    scheme: "PBES2";
    kp: KeyDerivationParams;
}

export interface SharedRawContainer extends BaseRawContainer {
    scheme: "shared";
    wp: AsymmetricCipherParams;
    ek: {
        [id: string]: CipherText;
    };
}

export type RawContainer = SimpleRawContainer | PasswordBasedRawContainer | SharedRawContainer;

export function validateRawContainer(raw: any): RawContainer {
    if (raw.version !== 2 || !raw.ep || !raw.ct) {
        throw new CryptoError("invalid_container_data");
    }

    validateCipherParams(raw.ep);

    switch (raw.scheme) {
        case "simple":
            break;
        case "PBES2":
            validateKeyDerivationParams(raw.kp);
            break;
        case "shared":
            validateCipherParams(raw.wp);
            break;
        default:
            throw new CryptoError("invalid_container_data");
    }

    return raw as RawContainer;
}

export function defaultEncryptionParams(): SymmetricCipherParams {
    return {
        cipherType: "symmetric",
        algorithm: "AES-GCM",
        tagSize: 64,
        keySize: 256
    };
}

export function defaultWrappingParams(): AsymmetricCipherParams {
    return {
        cipherType: "asymmetric",
        algorithm: "RSA-OAEP"
    };
}

export interface Participant {
    id: string;
    publicKey: PublicKey;
    privateKey?: PrivateKey;
    encryptedKey?: CipherText;
}

export class Container implements Storage, Storable {
    data?: Storable;
    cipherText?: CipherText;
    key?: SymmetricKey;
    password?: string;
    user?: Participant;
    private encryptedKeys: { [id: string]: CipherText } = {};

    constructor(
        public scheme: EncryptionScheme = "simple",
        public encryptionParams: SymmetricCipherParams = defaultEncryptionParams(),
        public keyDerivationParams: KeyDerivationParams = defaultKeyDerivationParams(),
        public wrappingParams: AsymmetricCipherParams = defaultWrappingParams()
    ) {}

    get storageKey() {
        return this.data ? this.data.storageKey : "";
    }

    get storageKind() {
        return this.data ? this.data.storageKind : "";
    }

    async getKey(): Promise<SymmetricKey> {
        switch (this.scheme) {
            case "simple":
                if (!this.key) {
                    this.key = await provider.randomKey(this.encryptionParams.keySize);
                }
                return this.key;
            case "PBES2":
                if (!this.keyDerivationParams.salt) {
                    this.keyDerivationParams.salt = provider.randomBytes(16);
                }
                if (!this.password) {
                    throw "no password provided";
                }
                return await provider.deriveKey(this.password, this.keyDerivationParams);
            case "shared":
                if (!this.user || !this.user.privateKey || !this.encryptedKeys) {
                    throw "Cannot derive key";
                }
                if (Object.keys(this.encryptedKeys).length) {
                    const encryptedKey = this.encryptedKeys[this.user.id];
                    return provider.decrypt(this.user.privateKey, encryptedKey, this.wrappingParams);
                } else {
                    return await provider.randomKey(this.encryptionParams.keySize);
                }
        }
    }

    async set(data: Storable) {
        this.data = data;
        this.encryptionParams.iv = provider.randomBytes(16);
        // TODO: useful additional authenticated data?
        this.encryptionParams.additionalData = provider.randomBytes(16);

        const key = await this.getKey();
        const pt = stringToBase64(marshal(await data.serialize()));
        this.cipherText = await provider.encrypt(key, pt, this.encryptionParams);
    }

    async get(data: Storable) {
        this.data = data;
        if (!this.cipherText) {
            throw "Nothing to get";
        }
        const key = await this.getKey();
        const pt = base64ToString(await provider.decrypt(key, this.cipherText, this.encryptionParams));
        await data.deserialize(unmarshal(pt));
    }

    async delete() {
        await this.clear();
    }

    async serialize() {
        const raw = {
            version: 2,
            scheme: this.scheme,
            ep: this.encryptionParams,
            ct: this.cipherText
        } as RawContainer;

        if (this.scheme === "PBES2") {
            (raw as PasswordBasedRawContainer).kp = this.keyDerivationParams;
        }

        if (this.scheme === "shared") {
            (raw as SharedRawContainer).wp = this.wrappingParams;
            (raw as SharedRawContainer).ek = this.encryptedKeys;
        }

        return raw as Marshalable;
    }

    async deserialize(raw: any) {
        raw = validateRawContainer(raw);
        this.scheme = raw.scheme;
        this.cipherText = raw.ct;
        this.encryptionParams = raw.ep;

        if (raw.scheme === "PBES2") {
            this.keyDerivationParams = raw.kp;
        }

        if (raw.scheme === "shared") {
            this.wrappingParams = raw.wp;
            this.encryptedKeys = raw.ek;
        }
        return this;
    }

    async addParticipant(p: Participant) {
        if (this.scheme !== "shared") {
            throw "Cannot add participant in this scheme";
        }
        const key = await this.getKey();
        this.encryptedKeys[p.id] = await provider.encrypt(p.publicKey, key, this.wrappingParams);
    }

    async clear() {
        delete this.password;
        delete this.user;
        delete this.key;
        delete this.cipherText;
        delete this.data;
        this.encryptedKeys = {};
    }
}

let provider: CryptoProvider;

export function setProvider(p: CryptoProvider) {
    provider = p;
}

export function getProvider() {
    return provider;
}
