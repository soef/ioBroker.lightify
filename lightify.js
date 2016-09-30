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
        adapter.log.error("Unknown device " + deviceName);
        return;
    }
    var mac = o.native.mac;
    var transitionTime = getState(dcs(deviceName, 'trans')) || 3;

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
            if (typeof state.val == 'string' && state.val[0] == '#') {
                colors.r = parseInt(state.val.substr(1, 2), 16);
                colors.g = parseInt(state.val.substr(3, 2), 16);
                colors.b = parseInt(state.val.substr(5, 2), 16);
                if (state.val.length > 7) colors.sat = parseInt(state.val.substr(7, 2), 16);
                lightify.node_color(mac, colors.r, colors.g, colors.b, colors.sat, transitionTime);
                break;
            }
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
    type:        { n: 'type',      g:1, val: 0, common: { min: 0, max: 255, write: false }},
    online:      { n: 'reachable', g:1, val: 0, common: { write: false }},
    groupid:     { n: 'groupid',   g:1, val: 0, common: { write: false }},
    status:      { n: 'on',        g:3, val: false, common: { min: false, max: true }},
    brightness:  { n: 'bri',       g:1, val: 0, common: { min: 0, max: 100, unit: '%', desc: '0..100%' }},
    temperature: { n: 'ct',        g:1, val: 0, common: { min: 0, max: 8000, unit: '°K', desc: 'in °Kelvin 0..8000' }},
    red:         { n: 'r',         g:1, val: 0, common: { min: 0, max: 255 }},
    green:       { n: 'g',         g:1, val: 0, common: { min: 0, max: 255 }},
    blue:        { n: 'b',         g:1, val: 0, common: { min: 0, max: 255 }},
    alpha:       { n: 'sat',       g:1, val: 0, common: { min: 0, max: 255 }},
    transition:  { n: 'trans',     g:1, val: 30,common: { unit: '\u2152 s', desc: 'in 10th seconds'} },

    command:     { n: 'command',   g:1, val: 'r:0, g:0, b:0, sat:255, on:true, transition:20' }
};

const LIGHT_GROUP_ROLE = 'LightGroup';
function createAll (callback) {

    var dev = new devices.CDevice(0, '');

    function create(data, role) {
        var g = role == LIGHT_GROUP_ROLE ?  2 : 1;
        for (var i = 0; i < data.result.length; i++) {
            var device = data.result[i];
            dev.setDevice(device.name, {common: {name: device.name, role: role}, native: { mac: device.mac, groups: device.groupid } });
            for (var j in usedStateNames) {
                if (usedStateNames[j].g & g) {
                    var st = Object.assign({}, usedStateNames[j]);
                    dev.createNew(st.n, st);
                }
            }
        }
    }

    lightify.discovery().then(function(data) {
        create(data, 'light.color');
        create( {result: [ {mac: 'ffffffffffffffff', name: 'All'}] }, LIGHT_GROUP_ROLE);
        lightify.zone_discovery().then(function (data) {
            //dev.setDevice('Groups', {common: {name: 'Groups', role: 'Groups'}});
            //for (var i = 0; i < data.result.length; i++) {
            //    var device = data.result[i];
            //    dev.set(device.name, device.id);
            //}

            //for (var i=0; i<data.result.length; i++) {
            //    data.result[i].mac = 'G.' + data.result[i].id;
            //}
            //create(data, LIGHT_GROUP_ROLE);
            devices.update(callback);
        })
    });
}


function updateDevices () {

    function update(data, g) {
        var dev = new devices.CDevice(0, '');
        for (var i = 0; i < data.result.length; i++) {
            var device = data.result[i];
            if (device.status != undefined) device.status = !!device.status;
            dev.setDevice(device.name, {common: {name: device.name}});
            for (var j in usedStateNames) {
                if (usedStateNames[j].g & g && device[j] !== undefined) {
                    dev.set(usedStateNames[j].n, device[j]);
                }
            }
        }
        dev.update();
    }

    lightify.discovery().then(function(data) {
        update(data, 1);
        //lightify.zone_discovery().then(function(data) {
        //    update(data, 2);
        //});
    });
}


function poll() {
    if (!adapter.config.polling) {
        return;
    }
    updateDevices();
    setTimeout(poll, adapter.config.intervall*1000);
}


function checkIP(callback) {
    if (adapter.config.ip) {
        callback();
        return;
    }

    function saveFoundIP(ip, callback) {
        adapter.getForeignObject("system.adapter." + adapter.namespace, function (err, obj) {
            obj.native.ip = ip;
            adapter.setForeignObject(obj._id, obj, {}, function (err, obj) {
                adapter.config.ip = ip;
                callback();
            });
        });
    }

    function getIPAddresses() {
        // found on stackoverflow
        var ips = [];
        var interfaces = require('os').networkInterfaces();
        for (var devName in interfaces) {
            var iface = interfaces[devName];

            for (var i = 0; i < iface.length; i++) {
                var alias = iface[i];
                if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal)
                    ips.push(alias.address);
            }
        }
        return ips;
    }

    adapter.log.info('No IP configurated, trying to find a gateway...');
    var ips = getIPAddresses();
    if (ips.length <= 0) {
        return;
    }

    var net = require('net');

    function tryIp(ip, cb) {
        var client = new net.Socket();
        client.setTimeout(1000, function() {
            client.destroy();
        });
        client.on('data', function(data) {
        });
        client.on('connect', function() {
            client.end();
            cb(ip);
        });
        client.connect(4000, ip, function() {
        });
    }

    ips.forEach(function (ownip) {
        var prefixIP = ownip.split('.', 3).join('.') + '.';
        adapter.log.info('Own IP: ' + ownip + ' Range: ' + prefixIP + '1...255');
        for (var i = 0; i < 255; i++) {
            tryIp(prefixIP + i, function (foundIp) {
                saveFoundIP(foundIp, callback);
            });
        }
    });
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

var maxTries = 5;
var startTimer = null;
function start() {
    if (maxTries-- <= 0) {
        return;
    }
    startTimer = setTimeout(start, 500);
    lightify.start(adapter.config.ip).then(function(data){
        if (startTimer) {
            clearTimeout(startTimer);
        }
        createAll(poll);
    });
}


function main() {
    checkIP (function() {
        start();
        adapter.subscribeStates('*');
    });
}

