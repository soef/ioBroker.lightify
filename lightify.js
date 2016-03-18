"use strict";


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// patch node-lightify to get & set the mac-value as hex string

Buffer.prototype.writeDoubleLE = function (val, pos) {
    return this.write(val, 0, 8, 'hex');
};
Buffer.prototype.readDoubleLE = function (pos, len) {
    return this.toString('hex', pos, pos+len);
};
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

var utils = require(__dirname + '/lib/utils'),
    soef = require(__dirname + '/lib/soef'),
    devices = new soef.Devices();

var lightify = require('node-lightify');

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

var adapter = utils.adapter({
    name: 'lightify',
    
    unload: function (callback) {
        try {
            callback();
        } catch (e) {
            callback();
        }
    },
    discover: function (callback) {
    },
    install: function (callback) {
    },
    uninstall: function (callback) {
    },
    objectChange: function (id, obj) {
    },
    stateChange: function (id, state) {
        if (state && !state.ack) {
            stateChange(id, state);
        }
    },
    ready: function () {
        devices.init(adapter, function(err) {
            main();
        });
    }
});

function getState(id, state) {
    //var s = id.replace(/\w+$/, state);
    //var s = id.replace(/\w+$/, '');
    var o = devices.get(id);
    if (o === undefined) return undefined;
    return o.val || 0;
}

function stateChange(id, state) {
    var ar = id.split('.');
    var deviceName = ar[2], stateName = ar[3];
    var o = devices.get(deviceName);
    if (o === undefined || o.native === undefined || !o.native.mac) {
        adapter.log("Unknown device " + deviceName);
        return;
    }
    var mac = o.native.mac;
    var transitionTime = getState(dcs(deviceName, 'tans')) || 3;

    function aktStates() {
        return {
            r: getState(dcs(deviceName, 'r')),
            g: getState(dcs(deviceName, 'g')),
            b: getState(dcs(deviceName, 'b')),
            sat: getState(dcs(deviceName, 'sat'))
        };
    }

    switch (stateName) {
        case 'on':
            lightify.node_on_off(mac, state.val >> 0 ? true : false);
            break;
        case 'r':
        case 'g':
        case 'b':
        case 'sat':
            var colors = aktStates();
            colors[stateName] = state.val >> 0;
            lightify.node_color(mac, colors.r, colors.g, colors.b, colors.sat, transitionTime);
            break;
        case 'bri':
            lightify.node_brightness(mac, state.val >> 0, transitionTime);
            break;
        case 'ct':
            lightify.node_temperature(mac, state.val >> 0, transitionTime);
            break;
        case 'command':
            //var v = state.val.replace(/red|green|blue|transition|bri|off/g, function(match) { return { red:'r', green:'g', blue:'b', transition:'x', bri:'l', off:'on:0'}[match] });
            var v = state.val.replace(/^on$|red|green|blue|transition|bri|off/g, function(match) { return { on:'on:1', red:'r', green:'g', blue:'b', transition:'x', bri:'l', off:'on:0'}[match] });
            v = v.replace(/\s|\"|;$|,$/g, '').replace(/=/g, ':').replace(/;/g, ',').replace(/true/g, 1).replace(/(r|g|b|x|l|sat|on|ct)/g, '"$1"').replace(/^\{?(.*?)\}?$/, '{$1}');
            try {
                var colors = JSON.parse(v);
            } catch (e) {
                adapter.log.error("on Command: " + e.message + ': state.val="' + state.val + '"');
                return;
            }
            if (!colors || typeof colors !== 'object') return;
            var o = fullExtend(aktStates(), colors);
            adapter.log.debug(JSON.stringify(o));
            if (o.x !== undefined) {
                transitionTime = o.x >> 0;
            }
            if (colors.r!==undefined || colors.g!==undefined || colors.b!==undefined || colors.sat!==undefined) {
                lightify.node_color(mac, o.r, o.g, o.b, o.sat, transitionTime);
            }
            if (o['on'] !== undefined) {
                lightify.node_on_off(mac, o.on >> 0 ? true : false);
            }
            if (o['ct'] !== undefined) {
                lightify.node_temperature(mac, o.ct >> 0, transitionTime);
            }
            if (o['l'] !== undefined) {
                lightify.node_brightness(mac, o.l >> 0, transitionTime);
            }
            break;
        default:
            return
    }
    setTimeout(updateDevices, 800);
}

var usedStateNames = {
    type:        { n: 'type',      val: 0, common: { min: 0, max: 255, write: false }},
    online:      { n: 'reachable', val: 0, common: { write: false }},
    //groupid:     { n: 'groupid',   val: 0, common: { write: false }},
    status:      { n: 'on',        val: false, common: { min: false, max: true }},
    brightness:  { n: 'bri',       val: 0, common: { min: 0, max: 100 }},
//    temperature: { n: 'ct',        val: 0, common: { min: 0, max: 5000 }},
    red:         { n: 'r',         val: 0, common: { min: 0, max: 255 }},
    green:       { n: 'g',         val: 0, common: { min: 0, max: 255 }},
    blue:        { n: 'b',         val: 0, common: { min: 0, max: 255 }},
    alpha:       { n: 'sat',       val: 0, common: { min: 0, max: 255 }},
    transition:  { n: 'trans',     val: 3 },

    command:     { n: 'command',   val: 'r:0, g:0, b:0, sat:255, on:true, transition:20' }
};


function createAll (callback) {

    var dev = new devices.CDevice(0, '');

    function create(data, role) {
        for (var i = 0; i < data.result.length; i++) {
            var device = data.result[i];
            dev.setDevice(device.name, {common: {name: device.name, role: role}, native: { mac: device.mac, groups: device.groupid } });
            for (var j in usedStateNames) {
                var st = Object.assign({}, usedStateNames[j]);
                dev.set(st.n, st);
            }
        }
    }

    lightify.discovery().then(function(data) {
        create(data, 'light.color');
        create( {result: [ {mac: 'ffffffffffffffff', name: 'All'}] }, 'LightGroup');
        lightify.zone_discovery().then(function (data) {
            //dev.setDevice('Groups', {common: {name: 'Groups', role: 'Groups'}});
            //for (var i = 0; i < data.result.length; i++) {
            //    var device = data.result[i];
            //    dev.set(device.name, device.id);
            //}
            devices.update(callback);
        })
    });
}


function updateDevices () {
    lightify.discovery().then(function(data) {
        var dev = new devices.CDevice(0, '');
        for (var i = 0; i < data.result.length; i++) {
            var device = data.result[i];
            dev.setDevice(device.name, {common: {name: device.name}});
            for (var j in usedStateNames) {
                if (device[j] !== undefined) {
                    dev.set(usedStateNames[j].n, device[j]);
                }
            }
        }
        dev.update();
    });
}


function poll() {
    if (!adapter.config.polling) {
        return;
    }
    updateDevices();
    setTimeout(poll, adapter.config.intervall*1000);
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function main() {

    lightify.start(adapter.config.ip).then(function(data){
        createAll(poll);
    });

    adapter.subscribeStates('*');
}

