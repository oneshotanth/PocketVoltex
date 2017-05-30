(function(window, document) {
"use strict";

var vid = 0x16D0;
var pid = 0x0A6D;
var UsbWrapper = window.UsbWrapper;

var device;

var SWITCH_COUNT = 8;
var BRIGHTNESS_MAX = 127;
var CONFIG_OUT_EPADDR = 1;
var CONFIG_IN_EPADDR  = 2;
var packetSize = 64;

var commands = {
    GETCONFIG : 1,
    SETCONFIG : 2,
    VERSION   : 3,
    RESET :     42
};

var configDisplay = [
    {id: 'joystickMode', name: 'Input mode',
        options : [{name: 'Keyboard/Mouse', val: 0}, {name: 'Joystick', val: 1}]},
    {id: 'switches', name: 'Keyboard bindings', labels: ['BT-A','BT-B','BT-C','BT-D','FX-L','FX-R','START']},
    {id: 'macroClick', name: 'Macro click'},
    {id: 'macroHold', name: 'Macro longpress'},
    {id: 'macroPin', name: 'Macro PIN'},
    {id: 'lightsOn', name: 'Enable LEDs', children: [
        {id: 'hidLights', name: 'HID Lights'},
        {id: 'keyLights', name: 'Key lights', children: [        
            {id: 'btColour', name: 'BT colour'},
            {id: 'fxColour', name: 'FX colour'},
        ]},
        {id: 'knobLights', name: 'Knob lights', children: [
            {id: 'knobL', name: 'VOL-L colour'},
            {id: 'knobR', name: 'VOL-R colour'},
        ]},
        {id: 'lightPattern', name: 'Lights pattern',
            options : [{name: 'None',     val : 1},
                       {name: 'Solid',    val: 2},
                       {name: 'Breathe',  val: 4},
                       {name: 'Follower', val: 3}]},
        {id: 'breatheColour', name: 'Solid/Breathe colour'},
    ]},
];

// to match with firmware
var settingOrder = [
    'switches',
    'btColour',
    'fxColour',
    'breatheColour',
    'knobL',
    'knobR',
    'lightsOn',
    'hidLights',
    'keyLights',
    'knobLights',
    'lightPattern',
    'macroClick',
    'macroHold',
    'macroPin',
    'joystickMode'
];

var defaultConfig = {
    switches   : [],
    ledsOn     : true,
    //macroClick : KP_PLUS,
    macroPin   : [0,0,0,0],
}

var visibleLog = function(html) {
    console.log(html);
    var log = document.getElementById('logview');
    log.innerHTML += html + '<br/>';
    log.scrollTop = log.scrollHeight;
}

class BinaryBuffer {
    constructor(view) {
        this.view = view;
        this.offset = 0;
    }
    
    read(size, forceArray = false) {
        let ret;
        if(size == 1 && !forceArray) {
            ret = this.view.getUint8(this.offset);
        } else {
            ret = [];
            for(var i = 0; i < size; i++) {
                ret[i] = this.view.getUint8(this.offset+i);
            }
        }
        this.offset += size;
        return ret;
    }
    
    write(data) {
        if(Array.isArray(data)) {
            for(let i = 0; i < data.length; i++) {
                this.view[this.offset+i] = data[i];
            }
            this.offset += data.length;
        } else {
            this.view[this.offset++] = data;
        }
    }
    
    rewind() {
        this.offset = 0;
    }
}

class ConfigValues {
    constructor() {
        this.switches      = new SettingKeys(SWITCH_COUNT, true);
        this.btColour      = new SettingRGB(BRIGHTNESS_MAX);
        this.fxColour      = new SettingRGB(BRIGHTNESS_MAX);
        this.breatheColour = new SettingRGB(BRIGHTNESS_MAX);
        this.knobL         = new SettingRGB(BRIGHTNESS_MAX);
        this.knobR         = new SettingRGB(BRIGHTNESS_MAX);
        this.lightsOn      = new SettingBool();
        this.hidLights     = new SettingBool();
        this.keyLights     = new SettingBool();
        this.knobLights    = new SettingBool();
        this.lightPattern  = new SettingRadio();
        this.macroClick    = new SettingMacro();
        this.macroHold     = new SettingMacro();
        this.macroPin      = new SettingKeys(4);
        this.joystickMode  = new SettingRadio();
    }
    
    read(view, writeCallback) {
        var buffer = new BinaryBuffer(view);
        // skip the returned command byte
        buffer.read(1);
        
        settingOrder.forEach(setting => {
            this[setting].read(buffer);
            this[setting].setCallback(writeCallback);
        });
    }

    write(view) {
        var buffer = new BinaryBuffer(view);
        buffer.write(commands.SETCONFIG);
        
        settingOrder.forEach(setting => {
            this[setting].write(buffer);
        });
    }

    getArray(view, offset, size) {
        var ret = [];
        for(var i = 0; i < size; i++) {
            ret[i] = view.getUint8(offset+i);
        }
        return ret;
    };

    getColour(view, offset) {
        return 'rgb(' + this.getArray(view, offset, 3).join() + ')';
    };

    getKeys(view, offset, size) {
        var keys = [];
        for(let i = 0; i < size; i++) {
            keys[i] = this.getKey(view, offset++);
        }
        return keys;
    }

    getKey(view, offset) {
        var key = view.getUint8(offset);
        return scancodes.find(code => {return code.value == key});
    }
}

class Config {
    constructor() {
        visibleLog("Welcome to the Pocket Voltex Configurator");
        this.optionsDiv = document.getElementById('configOptions');
        this.config = new ConfigValues();
        // DEBUG
        //this.enableUI();
    }
    
    connect() {
        return UsbWrapper.connect(vid, pid)
        .then(selectedDevice => {
            if(!selectedDevice) {
                return Promise.reject('No device selected');
            }
            device = selectedDevice;
            visibleLog("Opening device...");
            return device.open();
        })
        .then(() => {
            console.log("Opened, selecting configuration...");
            return device.selectConfiguration(1)
        })
        .then(() => {
            if(device.deviceVersionSubminor == 2) { // bootloader
                return this.loadFirmware();
            } else if(device.deviceVersionSubminor == 3) { // main program
                return this.loadConfig();
            } else {
                return Promise.reject("Invalid device found, is this a Tatacon converter?");
            }
        })
        .catch(error => {
            //alert(error);
            visibleLog(error);
            if(device && device.opened)
                device.close();
        });
    }
    
    loadFirmware() {
        visibleLog("Downloading fimware...");
        return getLatest()
        .then(downloadLatest)
        .then(firmware => {
            visibleLog("Flashing firmware...");
            return programLatest(device, firmware);
        })
        .then(() => {
            visibleLog("Done!");
        })
    }
    
    loadConfig() {
        console.log("Selected, claiming interface...");
        return device.claimInterface(0)
        .then(() => {
            visibleLog("Opened!");
            return this.readVersion();
        })
        .then(version => {
            this.version = version;
            visibleLog("Found Pocket Voltex v" + version/10.0);
            return getLatest();
        })
        .then(latestInfo => {
            if(latestInfo.version > this.version) {
                alert("Firmware update required. Device will be rebooted. Connect again to update");
                this.rebootToBootloader();
                return Promise.reject("Rebooted to bootloader, config read aborted");
            }
        })    
        .then(() => {
            this.enableUI();
            return this.readConfig();
        });
    }
    
    readVersion() {
        if(!device || !device.opened)
            return Promise.reject("Device not opened");
        
        var data = new Uint8Array(packetSize);
        data[0] = commands.VERSION;
        return device.transferOut(CONFIG_OUT_EPADDR, data)
        .then(() => device.transferIn(CONFIG_IN_EPADDR, packetSize))
        .then(result => {
            console.log(result);
            console.log("Got version response of len", result.data.buffer.byteLength);
            // version int exists at offset 1
            return result.data.getUint16(1, true);
        })
    }
    
    readConfig() {
        if(!device || !device.opened)
            return Promise.reject("Device not opened");
        var data = new Uint8Array(packetSize);
        data[0] = commands.GETCONFIG;
        return device.transferOut(CONFIG_OUT_EPADDR, data)
        .then(() => device.transferIn(CONFIG_IN_EPADDR, packetSize))
        .then(result => {
            console.log("Got config response of len", result.data.buffer.byteLength);
            this.config.read(result.data, this.writeConfig.bind(this));
        });
    }
    
    writeConfig() {
        if(!device || !device.opened)
            return Promise.reject("Device not opened");
        
        console.log("Writing config");
        var data = new Uint8Array(packetSize);
        this.config.write(data);
        return device.transferOut(CONFIG_OUT_EPADDR, data);
    }
    
    close() {
        if(!device || !device.opened)
            return Promise.reject("Device not opened");
        visibleLog("Closing device...");
        return device.close();
    }
    
    rebootToBootloader() {
        if(!device || !device.opened)
            return Promise.reject("Device not opened");
        var data = new Uint8Array(packetSize);
        data[0] = commands.RESET;
        return device.transferOut(CONFIG_OUT_EPADDR, data);
    };
    
    populateSettings(parent, settings) {
        settings.forEach(setting => {
            var settingObj = this.config[setting.id];
            var container = settingObj.createUI(setting);
            settingObj.setCallback(this.writeConfig.bind(this));
            
            if(setting.children) {
                var newParent = document.createElement('div');
                newParent.className = 'nestedSetting';
                
                this.populateSettings(newParent, setting.children);
                container.appendChild(newParent);
            }
            parent.appendChild(container);
        });
    }
    
    enableUI() {
        //document.getElementById('configBox').classList.remove('hidden', 'disabled');
        document.getElementById('connect').classList.add('hidden');
        this.populateSettings(this.optionsDiv, configDisplay);
    }
};

window.Config = Config;
window.visibleLog = visibleLog;

})(window, document);