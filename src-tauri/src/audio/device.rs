use serde::Serialize;
use std::sync::mpsc;
use std::thread;
use wasapi::{initialize_mta, get_default_device, Device, DeviceCollection, Direction};

#[derive(Debug, Clone, Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub exclusive: bool,
    pub current: bool,
    pub formats: String,
}

/// Look up a render device by its WASAPI id string. Caller MUST already be on
/// an MTA-initialized thread (the audio thread is — random Tauri threads may
/// not be). Returns `Err` if the id isn't found among the current render
/// devices (device could've been unplugged since enumeration).
pub fn get_device_by_id(id: &str) -> Result<Device, String> {
    let collection = DeviceCollection::new(&Direction::Render)
        .map_err(|e| format!("device collection: {:?}", e))?;
    let count = collection
        .get_nbr_devices()
        .map_err(|e| format!("device count: {:?}", e))?;
    for i in 0..count {
        let dev = collection
            .get_device_at_index(i)
            .map_err(|e| format!("device {}: {:?}", i, e))?;
        let dev_id = dev.get_id().unwrap_or_default();
        if dev_id == id {
            return Ok(dev);
        }
    }
    Err(format!("device id not found: {}", id))
}

pub fn list_devices() -> Result<Vec<AudioDevice>, String> {
    // Enumerate on a fresh thread so we can safely set COM apartment to MTA.
    // Tauri command threads may already be STA-initialized by other subsystems.
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(enumerate());
    });
    rx.recv().map_err(|e| e.to_string())?
}

fn enumerate() -> Result<Vec<AudioDevice>, String> {
    initialize_mta().map_err(|e| format!("COM init failed: {:?}", e))?;

    let default_id = get_default_device(&Direction::Render)
        .ok()
        .and_then(|d| d.get_id().ok());

    let collection = DeviceCollection::new(&Direction::Render)
        .map_err(|e| format!("device collection: {:?}", e))?;
    let count = collection
        .get_nbr_devices()
        .map_err(|e| format!("device count: {:?}", e))?;

    let mut devices = Vec::with_capacity(count as usize);
    for i in 0..count {
        let dev = collection
            .get_device_at_index(i)
            .map_err(|e| format!("device {}: {:?}", i, e))?;
        let name = dev
            .get_friendlyname()
            .map_err(|e| format!("name {}: {:?}", i, e))?;
        let id = dev
            .get_id()
            .map_err(|e| format!("id {}: {:?}", i, e))?;
        let is_default = default_id.as_deref() == Some(&id);
        devices.push(AudioDevice {
            id,
            name,
            driver: "WASAPI".into(),
            exclusive: true,
            current: is_default,
            formats: String::new(),
        });
    }

    Ok(devices)
}
