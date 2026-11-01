use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use parking_lot::Mutex;
use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::settings::{atomic_file, SecretStore, SettingsError};

pub(crate) const ENCRYPTED_SECRETS_FILE_NAME: &str = "api-keys.enc.json";
pub(crate) const LOCAL_SECRET_KEY_FILE_NAME: &str = ".api-keys.key";

const FORMAT_VERSION: u8 = 1;
const KEY_LENGTH: usize = 32;
const NONCE_LENGTH: usize = 12;
const MAX_ENCRYPTED_FILE_SIZE: u64 = 1_048_576;
const ASSOCIATED_DATA: &[u8] = b"com.local.flick/api-keys/v1";
// Keep historical AAD literals so existing installations can decrypt API keys
// written before product renames.
const LEGACY_ASSOCIATED_DATA: &[&[u8]] = &[
    b"com.local.onelenth/api-keys/v1",
    b"com.local.textlens/api-keys/v1",
    b"com.local.selectionbar/api-keys/v1",
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncryptedSecretsFile {
    version: u8,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug)]
pub(crate) struct LocalEncryptedStore {
    data_path: PathBuf,
    key_path: PathBuf,
    entries: Mutex<HashMap<String, String>>,
}

impl LocalEncryptedStore {
    pub(crate) fn for_settings_file(settings_path: &Path) -> Result<Self, SettingsError> {
        Self::new(
            settings_path.with_file_name(ENCRYPTED_SECRETS_FILE_NAME),
            settings_path.with_file_name(LOCAL_SECRET_KEY_FILE_NAME),
        )
    }

    fn new(data_path: PathBuf, key_path: PathBuf) -> Result<Self, SettingsError> {
        let entries = load_entries(&data_path, &key_path)?;
        Ok(Self {
            data_path,
            key_path,
            entries: Mutex::new(entries),
        })
    }

    fn persist(&self, entries: &HashMap<String, String>) -> Result<(), SettingsError> {
        let mut key_bytes = load_or_create_key(&self.key_path)?;
        let encrypted = encrypt_entries(entries, &key_bytes);
        key_bytes.fill(0);
        write_private_atomic(&self.data_path, &encrypted?)
    }
}

impl SecretStore for LocalEncryptedStore {
    fn get(&self, account: &str) -> Result<Option<String>, SettingsError> {
        Ok(self.entries.lock().get(account).cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), SettingsError> {
        let mut entries = self.entries.lock();
        let mut candidate = entries.clone();
        candidate.insert(account.to_owned(), secret.to_owned());
        self.persist(&candidate)?;
        *entries = candidate;
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), SettingsError> {
        let mut entries = self.entries.lock();
        if !entries.contains_key(account) {
            return Ok(());
        }
        let mut candidate = entries.clone();
        candidate.remove(account);
        self.persist(&candidate)?;
        *entries = candidate;
        Ok(())
    }
}

fn load_entries(
    data_path: &Path,
    key_path: &Path,
) -> Result<HashMap<String, String>, SettingsError> {
    let metadata = match fs::metadata(data_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err(SettingsError::SecretStorage),
    };
    if metadata.len() > MAX_ENCRYPTED_FILE_SIZE {
        return Err(SettingsError::SecretStorage);
    }
    harden_existing_file(data_path)?;
    harden_existing_file(key_path)?;
    if let Some(parent) = data_path.parent() {
        harden_directory(parent)?;
    }

    let encoded = fs::read(data_path).map_err(|_| SettingsError::SecretStorage)?;
    let file: EncryptedSecretsFile =
        serde_json::from_slice(&encoded).map_err(|_| SettingsError::SecretStorage)?;
    if file.version != FORMAT_VERSION {
        return Err(SettingsError::SecretStorage);
    }
    let nonce = STANDARD_NO_PAD
        .decode(file.nonce)
        .map_err(|_| SettingsError::SecretStorage)?;
    if nonce.len() != NONCE_LENGTH {
        return Err(SettingsError::SecretStorage);
    }
    let mut ciphertext = STANDARD_NO_PAD
        .decode(file.ciphertext)
        .map_err(|_| SettingsError::SecretStorage)?;
    let mut key_bytes = read_key(key_path)?;
    let result = decrypt_entries(&mut ciphertext, &nonce, &key_bytes);
    key_bytes.fill(0);
    ciphertext.fill(0);
    result
}

fn encrypt_entries(
    entries: &HashMap<String, String>,
    key_bytes: &[u8; KEY_LENGTH],
) -> Result<Vec<u8>, SettingsError> {
    let mut nonce_bytes = [0_u8; NONCE_LENGTH];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| SettingsError::SecretStorage)?;
    let key = aead_key(key_bytes)?;
    let mut ciphertext = serde_json::to_vec(entries).map_err(|_| SettingsError::SecretStorage)?;
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_bytes),
        Aad::from(ASSOCIATED_DATA),
        &mut ciphertext,
    )
    .map_err(|_| SettingsError::SecretStorage)?;
    let file = EncryptedSecretsFile {
        version: FORMAT_VERSION,
        nonce: STANDARD_NO_PAD.encode(nonce_bytes),
        ciphertext: STANDARD_NO_PAD.encode(ciphertext),
    };
    serde_json::to_vec_pretty(&file).map_err(|_| SettingsError::SecretStorage)
}

fn decrypt_entries(
    ciphertext: &mut [u8],
    nonce_bytes: &[u8],
    key_bytes: &[u8; KEY_LENGTH],
) -> Result<HashMap<String, String>, SettingsError> {
    if let Ok(entries) =
        decrypt_entries_with_aad(ciphertext, nonce_bytes, key_bytes, ASSOCIATED_DATA)
    {
        return Ok(entries);
    }
    let mut last_error = SettingsError::SecretStorage;
    for associated_data in LEGACY_ASSOCIATED_DATA {
        let mut legacy_ciphertext = ciphertext.to_vec();
        match decrypt_entries_with_aad(
            &mut legacy_ciphertext,
            nonce_bytes,
            key_bytes,
            associated_data,
        ) {
            Ok(entries) => return Ok(entries),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn decrypt_entries_with_aad(
    ciphertext: &mut [u8],
    nonce_bytes: &[u8],
    key_bytes: &[u8; KEY_LENGTH],
    associated_data: &[u8],
) -> Result<HashMap<String, String>, SettingsError> {
    let key = aead_key(key_bytes)?;
    let nonce =
        Nonce::try_assume_unique_for_key(nonce_bytes).map_err(|_| SettingsError::SecretStorage)?;
    let plaintext = key
        .open_in_place(nonce, Aad::from(associated_data), ciphertext)
        .map_err(|_| SettingsError::SecretStorage)?;
    serde_json::from_slice(plaintext).map_err(|_| SettingsError::SecretStorage)
}

fn aead_key(key_bytes: &[u8; KEY_LENGTH]) -> Result<LessSafeKey, SettingsError> {
    UnboundKey::new(&AES_256_GCM, key_bytes)
        .map(LessSafeKey::new)
        .map_err(|_| SettingsError::SecretStorage)
}

fn load_or_create_key(path: &Path) -> Result<[u8; KEY_LENGTH], SettingsError> {
    match read_key(path) {
        Ok(key) => Ok(key),
        Err(SettingsError::SecretStorage) if !path.exists() => {
            // Serialize first use inside this process. Atomic publication
            // below still protects multiple TextLens processes, while this
            // avoids eight local threads simultaneously creating temporary
            // keys and contending in MoveFileExW/antivirus filters.
            let _creation = key_creation_lock().lock();
            match read_key(path) {
                Ok(key) => Ok(key),
                Err(SettingsError::SecretStorage) if !path.exists() => create_key(path),
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

fn key_creation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_key(path: &Path) -> Result<[u8; KEY_LENGTH], SettingsError> {
    let bytes = fs::read(path).map_err(|_| SettingsError::SecretStorage)?;
    let key: [u8; KEY_LENGTH] = bytes.try_into().map_err(|_| SettingsError::SecretStorage)?;
    harden_existing_file(path)?;
    Ok(key)
}

fn create_key(path: &Path) -> Result<[u8; KEY_LENGTH], SettingsError> {
    prepare_parent(path)?;
    let mut key = [0_u8; KEY_LENGTH];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| SettingsError::SecretStorage)?;

    // Publish only a fully written key. A direct create/write of the final
    // path can leave a partial key after a crash, and another app instance can
    // observe it before the write completes. The platform helper performs an
    // atomic, no-overwrite publication on the same filesystem.
    let temporary = path.with_extension(format!("key-tmp-{}", Uuid::new_v4().simple()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(&key)?;
        file.sync_all()
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
        key.fill(0);
        return Err(SettingsError::SecretStorage);
    }

    match atomic_file::publish_new_file(&temporary, path) {
        Ok(()) => {
            harden_existing_file(path)?;
            Ok(key)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists || path.exists() => {
            let _ = fs::remove_file(&temporary);
            key.fill(0);
            read_published_key(path)
        }
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            key.fill(0);
            Err(SettingsError::SecretStorage)
        }
    }
}

fn read_published_key(path: &Path) -> Result<[u8; KEY_LENGTH], SettingsError> {
    // Windows may briefly report sharing/access errors while the winning
    // process completes MoveFileExW publication. The file is already atomic;
    // a tiny bounded retry avoids treating that visibility window as corrupt
    // secret storage during concurrent first launch.
    for attempt in 0..5 {
        match read_key(path) {
            Ok(key) => return Ok(key),
            Err(_) if attempt < 4 && path.exists() => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => return Err(error),
        }
    }
    Err(SettingsError::SecretStorage)
}

fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), SettingsError> {
    prepare_parent(path)?;
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        // Close the replacement before the platform atomic rename. Windows
        // otherwise returns ERROR_SHARING_VIOLATION for its own open handle.
        drop(file);
        atomic_file::replace_file(&temporary, path)?;
        Ok::<(), std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(SettingsError::SecretStorage);
    }
    harden_existing_file(path)?;
    Ok(())
}

fn prepare_parent(path: &Path) -> Result<(), SettingsError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| SettingsError::SecretStorage)?;
        harden_directory(parent)?;
    }
    Ok(())
}

fn harden_existing_file(path: &Path) -> Result<(), SettingsError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| SettingsError::SecretStorage)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn harden_directory(path: &Path) -> Result<(), SettingsError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| SettingsError::SecretStorage)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;
    use tempfile::tempdir;

    #[test]
    fn secrets_are_encrypted_and_survive_reopen() {
        let directory = tempdir().unwrap();
        let data_path = directory.path().join(ENCRYPTED_SECRETS_FILE_NAME);
        let key_path = directory.path().join(LOCAL_SECRET_KEY_FILE_NAME);
        let store = LocalEncryptedStore::new(data_path.clone(), key_path.clone()).unwrap();
        store.set("provider-a", "sk-local-secret").unwrap();
        assert_eq!(
            store.get("provider-a").unwrap().as_deref(),
            Some("sk-local-secret")
        );
        assert!(!fs::read_to_string(&data_path)
            .unwrap()
            .contains("sk-local-secret"));
        assert!(!fs::read(&key_path)
            .unwrap()
            .windows("sk-local-secret".len())
            .any(|window| window == b"sk-local-secret"));

        drop(store);
        let reopened = LocalEncryptedStore::new(data_path, key_path).unwrap();
        assert_eq!(
            reopened.get("provider-a").unwrap().as_deref(),
            Some("sk-local-secret")
        );
    }

    #[test]
    fn opens_the_existing_v1_encrypted_store_format() {
        let directory = tempdir().unwrap();
        let data_path = directory.path().join(ENCRYPTED_SECRETS_FILE_NAME);
        let key_path = directory.path().join(LOCAL_SECRET_KEY_FILE_NAME);

        // Compatibility fixture generated with AES-256-GCM using a 32-byte
        // 0x42 key, a 12-byte 0x24 nonce, and the original v1 associated data.
        // Keeping the ciphertext fixed detects accidental changes to the file
        // version, AAD, tag placement, key length, or Base64 convention.
        fs::write(&key_path, [0x42_u8; KEY_LENGTH]).unwrap();
        fs::write(
            &data_path,
            br#"{
              "version": 1,
              "nonce": "JCQkJCQkJCQkJCQk",
              "ciphertext": "brO0M4awr1pDmg/LzVu+zQmCCR/Gzj4M2YmvNTu1hmdraT3gX36Ib75r3NI1z8Hrlc82cu302KPhtNYk2TZEXn0KkKQM"
            }"#,
        )
        .unwrap();

        let store = LocalEncryptedStore::new(data_path, key_path).unwrap();

        assert_eq!(
            store
                .get("provider-api-key:openai-compatible")
                .unwrap()
                .as_deref(),
            Some("sk-legacy-v1")
        );
        assert_eq!(FORMAT_VERSION, 1);
        assert_eq!(
            LEGACY_ASSOCIATED_DATA,
            &[
                &b"com.local.onelenth/api-keys/v1"[..],
                &b"com.local.textlens/api-keys/v1"[..],
                &b"com.local.selectionbar/api-keys/v1"[..]
            ]
        );
        assert_eq!(ASSOCIATED_DATA, b"com.local.flick/api-keys/v1");
        assert_eq!(ENCRYPTED_SECRETS_FILE_NAME, "api-keys.enc.json");
        assert_eq!(LOCAL_SECRET_KEY_FILE_NAME, ".api-keys.key");
    }

    #[test]
    fn every_save_uses_a_fresh_nonce() {
        let directory = tempdir().unwrap();
        let data_path = directory.path().join(ENCRYPTED_SECRETS_FILE_NAME);
        let key_path = directory.path().join(LOCAL_SECRET_KEY_FILE_NAME);
        let store = LocalEncryptedStore::new(data_path.clone(), key_path).unwrap();
        store.set("provider-a", "same-secret").unwrap();
        let first = fs::read(&data_path).unwrap();
        store.set("provider-a", "same-secret").unwrap();
        let second = fs::read(data_path).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn concurrent_first_use_publishes_one_complete_key() {
        let directory = tempdir().unwrap();
        let key_path = Arc::new(directory.path().join(LOCAL_SECRET_KEY_FILE_NAME));
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|_| {
                let key_path = key_path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    load_or_create_key(&key_path).unwrap()
                })
            })
            .collect::<Vec<_>>();
        let keys = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert!(keys.iter().all(|key| key == &keys[0]));
        assert_eq!(fs::read(key_path.as_ref()).unwrap().len(), KEY_LENGTH);
    }

    #[test]
    fn tampering_or_losing_the_key_is_never_silently_overwritten() {
        let directory = tempdir().unwrap();
        let data_path = directory.path().join(ENCRYPTED_SECRETS_FILE_NAME);
        let key_path = directory.path().join(LOCAL_SECRET_KEY_FILE_NAME);
        let store = LocalEncryptedStore::new(data_path.clone(), key_path.clone()).unwrap();
        store.set("provider-a", "secret").unwrap();
        drop(store);

        let original = fs::read(&data_path).unwrap();
        let mut tampered: EncryptedSecretsFile = serde_json::from_slice(&original).unwrap();
        tampered.ciphertext.push('A');
        fs::write(&data_path, serde_json::to_vec(&tampered).unwrap()).unwrap();
        assert!(matches!(
            LocalEncryptedStore::new(data_path.clone(), key_path.clone()),
            Err(SettingsError::SecretStorage)
        ));

        fs::write(&data_path, original).unwrap();
        fs::remove_file(&key_path).unwrap();
        let encrypted_before = fs::read(&data_path).unwrap();
        assert!(matches!(
            LocalEncryptedStore::new(data_path.clone(), key_path.clone()),
            Err(SettingsError::SecretStorage)
        ));
        assert_eq!(fs::read(data_path).unwrap(), encrypted_before);
        assert!(!key_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn local_secret_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let data_path = directory.path().join(ENCRYPTED_SECRETS_FILE_NAME);
        let key_path = directory.path().join(LOCAL_SECRET_KEY_FILE_NAME);
        let store = LocalEncryptedStore::new(data_path.clone(), key_path.clone()).unwrap();
        store.set("provider-a", "secret").unwrap();
        assert_eq!(
            fs::metadata(data_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(key_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
