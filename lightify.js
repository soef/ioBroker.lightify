"use strict";

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// patch node-lightify to get & set the mac-value as hex string

Buffer.prototype.writeDoubleLE = function (val, pos) {
    return this.write(val.toLowerCase(), 0, 8, 'hex');
};
Buffer.prototype.readDoubleLE = function (pos, len) {
    return this.toString('hex', pos, pos+len).toUpperCase();
};
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

var soef = require('soef');
//var lightify = require('node-lightify');
var lightify = require('node-lightify-soef');

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


var updateTimer = soef.Timer();
var adapter = soef.Adapter (
    main,
    onStateChange,
    onUnload,
    onUpdate,
    {
        name: 'lightify',
    }
);

function onUnload(callback) {
    //close socket in node-lightify
    if (lightify && lightify.close) {
        lightify.close();
    }
    callback();
}


function onUpdate(oldVersion, newVersion, callback) {
    if(oldVersion < 22) {
        removeAllObjects(adapter, callback);
        return;
    }
    callback();
}

function getState(id, state) {
    //var s = id.replace(/\w+$/, state);
    //var s = id.replace(/\w+$/, '');
    var o = devices.get(id);
    if (o === undefined) return undefined;
    return o.val || 0;
}

function getBrightness(co) {
    //var bri = (co.r * 299 + co.g * 587 + co.b*114) / 2560;
    var bri = (co.r + co.g + co.b) * 100 / (256+256+256);
    return Math.round(bri);
}

function parseHexColors(val) {
    val = val.toString();
    var ar = val.split('.');
    if (ar && ar.length > 1) val = ar[0];
    if (val[0] === '#') val = val.substr(1);
    var co = {
        r: parseInt(val.substr(0, 2), 16),
        g: parseInt(val.substr(2, 2), 16) || 0,
        b: parseInt(val.substr(4, 2), 16) || 0 //,
    };
    if (val.length > 7) {
        co.w = parseInt(val.substr(6, 2), 16);
    }
    if (ar && ar.length > 1) {
        var m = Number('.' + ar[1]);
        for (var i in co) {
            co[i] *= m;
        }
        roundRGB(co);
    }
    return co;
}

function onStateChange(id, state) {
    var ar = id.split('.');
    var deviceName = ar[2], stateName = ar[3];
    var o = devices.get(deviceName);
    if (o === undefined || o.native === undefined || !o.native.mac) {
        if (deviceName === 'refresh') {
            createAll(setTimeout(updateDevices, 1000));
            return;
        }
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

    devices.invalidate(id);
    switch (stateName) {
        case usedStateNames.transition.n:
            devices.setrawval(id, state.val);
            break;
        case 'refresh':
            updateDevices(mac);
            break;
        case 'rgbw':
        case 'rgb':
            var colors = parseHexColors(state.val);
            colors.sat = colors.w != undefined ? colors.w : getState(dcs(deviceName, 'sat'))
            var bri = getBrightness(colors);
            colors.sat = 0x80;
            lightify.node_color(mac, colors.r, colors.g, colors.b, colors.sat, transitionTime);
            lightify.node_brightness(mac, bri, 0);
            break;

        case 'on':
            lightify.node_on_off(mac, state.val >> 0 ? true : false);
            break;
        case 'r':
        case 'g':
        case 'b':
        case 'sat':
            var colors;
            if (typeof state.val == 'string' && state.val[0] == '#') {
                colors = parseHexColors(state.val);
                colors.sat = colors.w != undefined ? colors.w : getState(dcs(deviceName, 'sat'))
            } else {
                colors = aktStates();
                colors[stateName] = state.val >> 0;
            }
            lightify.node_color(mac, colors.r, colors.g, colors.b, colors.sat, transitionTime);
            break;

        case 'bri':
            lightify.node_brightness(mac, state.val >> 0, transitionTime);
            break;
        case 'ct':
            lightify.node_temperature(mac, state.val >> 0, transitionTime);
            break;
        case 'command':
            var v = state.val.replace(/^on$|red|green|blue|transition|bri|off|#/g, function(match) { return { '#': '#', of:'off:1', on:'on:1', red:'r', green:'g', blue:'b', white: 'w', transition:'x', bri:'l', off:'on:0'}[match] });
            v = v.replace(/\s|\"|;$|,$/g, '').replace(/=/g, ':').replace(/;/g, ',').replace(/true/g, 1).replace(/#((\d|[a-f]|[A-F])*)/g, 'h:"$1"').replace(/(r|g|b|w|x|l|sat|of|on|ct|h)/g, '"$1"').replace(/^\{?(.*?)\}?$/, '{$1}');
            try {
                var colors = JSON.parse(v);
            } catch (e) {
                adapter.log.error("on Command: " + e.message + ': state.val="' + state.val + '"');
                return;
            }
            if (colors.h) {
                var co = parseHexColors('#'+colors.h);
                colors.r = co.r; colors.g = co.g; colors.b = co.b;
                delete colors.h;
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
    setTimeout(updateDevices, 800, mac);
    if (transitionTime*100 > 800) setTimeout(updateDevices, transitionTime*100, mac);
}

var tf = {
    BRI: 0xae, // ((~FT_SWITCH) & (~FT_PLUG)) & 0xff, //0xffee,   // 0x04?
    CT: 0x02,
    RGB: 0x08,
    SWITCH: 0x40,
    PLUG: 0x10,
    LIGHT: 0xae,
    ALL: 0xff
};


var usedStateNames = {
    type:        { n: 'type',      g:1, tf: tf.ALL,   val: 0, common: { min: 0, max: 255, write: false }},
    online:      { n: 'reachable', g:1, tf: tf.ALL,   val: 0, common: { write: false }},
    groupid:     { n: 'groupid',   g:1, tf: tf.ALL,   val: 0, common: { write: false }},
    status:      { n: 'on',        g:7, tf: tf.ALL,   val: false, common: { min: false, max: true }},
    brightness:  { n: 'bri',       g:3, tf: tf.BRI,   val: 0, common: { min: 0, max: 100, unit: '%', desc: '0..100%' }},
    temperature: { n: 'ct',        g:3, tf: tf.CT,    val: 0, common: { min: 2700, max: 6500, unit: '°K', desc: 'in °Kelvin 2700..6500' }},
    red:         { n: 'r',         g:3, tf: tf.RGB,   val: 0, common: { min: 0, max: 255 }},
    green:       { n: 'g',         g:3, tf: tf.RGB,   val: 0, common: { min: 0, max: 255 }},
    blue:        { n: 'b',         g:3, tf: tf.RGB,   val: 0, common: { min: 0, max: 255 }},
    alpha:       { n: 'sat',       g:3, tf: tf.RGB,   val: 0, common: { min: 0, max: 255 }},
    transition:  { n: 'trans',     g:3, tf: tf.LIGHT, val: 30,common: { unit: '\u2152 s', desc: 'in 10th seconds'} },

    command:     { n: 'command',   g:3, tf: tf.LIGHT, val: 'r:0, g:0, b:0, sat:255, on:true, transition:20' },
    refresh:     { n: 'refresh',   g:1, tf: tf.LIGHT, val: false, common: { min: false, max: true, desc: 'read states from device' }},
    rgb:         { n: 'rgb',       g:3, tf: tf.RGB,   val: '',    common: { desc: '000000..ffffff' }}

};


var F_DEVICE = 1,
    F_GROUP = 2,
    F_ALL = 4;

var groupSufix = '00000000000000',
    _00000000000000 = '00000000000000',
    groupIdAll = 'FFFFFFFFFFFFFFFF';

function isGroupId(id) {
    if(!id || id.length < groupSufix.length+2) return false;
    return id === groupIdAll || id.substr(2) === groupSufix;
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function createAll (callback) {

    var dev = new devices.CDevice(0, '');
    var existingDevices = [];

    function create(data, gFlag) {
        for (var i = 0; i < data.result.length; i++) {
            var device = data.result[i];
            existingDevices.push(device.mac);
            //dev.setDevice(device.mac, {common: {name: device.name, role: gFlag&F_DEVICE?'Device':'Group'}, native: { mac: device.mac, groups: device.groupid } });
            dev.setChannel(device.mac, {common: {name: device.name, role: gFlag&F_DEVICE?'Device':'Group'}, native: { mac: device.mac, groups: device.groupid } });
            for (var j in usedStateNames) {
                if (usedStateNames[j].g & gFlag && (gFlag & F_GROUP) || (device.type & usedStateNames[j].tf)) {
                    var st = Object.assign({}, usedStateNames[j]);
                    dev.createNew(st.n, st);
                }
            }
        }
    }

    function checkDeletedDevices() {
        devices.foreach('*', function(id) {
            if (id.indexOf('.') >= 0 || id === 'refresh'/*|| isGroupId(id)*/) return true;
            if (!existingDevices.find(function (v) {
                return v == id;
            })) {
                //adapter.deleteChannel(id);
                dcs.del(id);
                //deleteObjectWithStates(id);
                //devices.remove(id);
            }
            return true;
        });

    }

    lightify.discovery().then(function(data) {
        create(data, F_DEVICE);
        create( {result: [ {mac: groupIdAll, name: 'All'}] }, F_GROUP);
        lightify.zone_discovery().then(function (data) {

            for (var i=0; i<data.result.length; i++) {
                data.result[i].mac = soef.sprintf('%02x00000000000000', data.result[i].id);
            }
            create(data, F_GROUP);
            //devices.update(callback);
            checkDeletedDevices();
            dev.update(function () {
                devices.root.set('refresh', usedStateNames.refresh);
                devices.update(callback);
            });
        })
    });
}


function updateDevices (mac) {

    function update(data) {
        var g = 1;
        var dev = new devices.CDevice(0, '');
        for (var i = 0; i < data.result.length; i++) {
            var device = data.result[i];
            if (device.status != undefined) device.status = !!device.status;
            dev.setChannel(device.mac); //, device.name ? {common: {name: device.name}} : undefined); //, {common: {name: device.name}});
            dev.setName(device.name);

            var o = {};
            o.bri = device.brightness; // * 10;// * 2560;
            o.red = Math.round((device.red * o.bri) / 100);
            o.green = Math.round((device.green * o.bri) / 100);
            o.blue = Math.round((device.blue * o.bri) / 100);
            device.rgb = soef.sprintf('%02X%02X%02X', o.red, o.green, o.blue, device.alpha);


            for (var j in usedStateNames) {
                if (usedStateNames[j].g & g && device[j] !== undefined && (device.type & usedStateNames[j].tf)) {
                    dev.set(usedStateNames[j].n, device[j]);
                }
            }
        }
        dev.update();
    }


    if (mac && lightify.get_status != undefined && !isGroupId(mac)) {
        lightify.get_status(mac).then(update);
    } else {
        lightify.discovery().then(update);
    }
}


function poll() {
    updateDevices();
    if (!adapter.config.polling || adapter.config.intervall <= 0) {
        return;
    }
    updateTimer.set(poll, adapter.config.intervall*1000);
}


function checkIP(callback) {
    if (adapter.config.ip) {
        callback();
        return;
    }

    function saveFoundIP(ip, callback) {
        soef.changeConfig(function(config) {
            config.ip = ip;
            adapter.config.ip = ip;
        }, callback);
        // adapter.getForeignObject("system.adapter." + adapter.namespace, function (err, obj) {
        //     obj.native.ip = ip;
        //     adapter.setForeignObject(obj._id, obj, {}, function (err, obj) {
        //         adapter.config.ip = ip;
        //         callback();
        //     });
        // });
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
        client.on('error', function(data) {
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

function normalizeConfig(config) {
    config.intervall = config.intervall >> 0;
    config.polling = config.polling ? true : false;
}

var errorCnt = 0;

function start() {
    var oTimeout;
    
    function onError (error) {
        switch (error.errno) { //error.code
            //case undefined:
            //    if (error.message != "This socket is closed") return;
            case 'ETIMEDOUT':
            case 'ECONNRESET':
            case 'EPIPE':
                if (oTimeout) clearTimeout(oTimeout);
                oTimeout = setTimeout(function() {
                    start();
                    //lightify.close();
                    //lightify.start(adapter.config.ip, onError, false);
                }, 3000);
                break;
        }
    }

    updateTimer.clear();
    lightify.close();
    lightify.start(adapter.config.ip, onError, false).then(function(){
        errorCnt = 0;
        createAll(poll);
    }).catch(function (err) {
        if (err === "timeout") {
            setTimeout(start, errorCnt <= 5 ? 1000 : 10000);
            if (errorCnt++ === 5) {
                adapter.log.error('Can not connect to Lightify Gateway ' + adapter.config.ip);
            }
        }
    });
}


function main() {
    normalizeConfig(adapter.config);
    checkIP (function() {
        start();
        adapter.subscribeStates('*');
    });
}

/*
type  2: SurfaceTW, LIGHTIFY Surface Light Turable White
tyüe 10: A60RGBW, LIGHTIFY CLA 60 RGBW
type  4: SurfaceW, LIGHTIFY Surface Light W 28
 */

//https://api.github.com/repos/soef/node-lightify/tarball/master