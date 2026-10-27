declare global {
    interface Window {
        electronStore?: StorageType;
    }
}

import {StorageType} from "../interfaces/helper";

let isElectron = false;

try {
    isElectron = !!window.electronStore
} catch (e) {
    isElectron = false;
}

let storage : StorageType;
let browserToken: string | undefined;
// Browser mode has no OS credential vault. Purge old persistent sessions.
if (!isElectron) localStorage.removeItem('token');

if (isElectron) {
    storage = {
        get: async (key : string ) => await window.electronStore!.get(key),
        set: async (key : string, value : any) => await window.electronStore!.set(key, value),
        remove: async (key : any) => await window.electronStore!.remove(key),
    };
} else {
    storage = {
        get: async (key: string) => {
            return key === 'token' ? browserToken : localStorage.getItem(key);
        },
        set: async (key: string, value: any) => {
            if (key === 'token') { browserToken = value; return; }
            return localStorage.setItem(key, value);
        },
        remove: async (key: any) => {
            if (key === 'token') browserToken = undefined;
            return localStorage.removeItem(key);
        },
    };
}

export default storage;
