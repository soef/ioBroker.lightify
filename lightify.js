'use strict';

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// patch node-lightify to get & set the mac-value as hex string

Buffer.prototype.writeDoubleLE = function (val/*, pos*/) {
    return this.write(val.toLowerCase(), 0, 8, 'hex');
};
Buffer.prototype.readDoubleLE = function (pos, len) {
    return this.toString('hex', pos, pos + len).toUpperCase();
};
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

var soef = require('soef');
var Lightify = require(__dirname + '/lib/lightify');//require('node-lightify-soef');
var net;
var lightify;
var types = {};
var connected = false;
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


var updateTimer = soef.Timer();
var adapter = soef.Adapter(
    main,
    onStateChange,
    onUnload,
    onUpdate,
    {
        name: 'lightify'
    }
);

adapter.on('message', function (obj) {
    if (obj) {
        switch (obj.command) {
            case 'browse':
                if (obj.callback) {
                    browse(function (list) {
                        adapter.sendTo(obj.from, obj.command, list, obj.callback);
                    });
                }

                break;
        }
    }
});

function onUnload(callback) {
    //close socket in node-lightify
    if (lightify && lightify.dispose) {
        lightify.dispose();
        lightify = null;
    }
    callback();
}

function onUpdate(oldVersion, newVersion, callback) {
    if (oldVersion < 22) {
        soef.njs.removeAllObjects(adapter, callback);
        return;
    }
    callback();
}

function getState(id) {
    //var s = id.replace(/\w+$/, state);
    //var s = id.replace(/\w+$/, '');
    var o = devices.get(id);
    if (o === undefined) return undefined;
    return o.val || 0;
}

/*function getBrightness(co) {
    //var bri = (co.r * 299 + co.g * 587 + co.b*114) / 2560;
    var bri = (co.r + co.g + co.b) * 100 / (256 + 256 + 256);
    return Math.round(bri);
}*/

function parseHexColors(val) {
    val = val.toString();
    var ar = val.split('.');
    if (ar && ar.length > 1) {
        val = ar[0];
    }
    if (val[0] === '#') {
        val = val.substr(1);
    }

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
        // TODO
        // roundRGB(co);
    }
    return co;
}

function onStateChange(id, state) {
    var ar = id.split('.');
    var deviceName = ar[2];
    var stateName = ar[3];

    var o = devices.get(deviceName);
    if (o === undefined || o.native === undefined || !o.native.mac) {
        if (deviceName === 'refresh') {
            createAll(function () {
                setTimeout(updateDevices, 1000);
            });
            return;
        }
        adapter.log.error('Unknown device ' + deviceName);
        return;
    }
    var mac = o.native.mac;
    var transitionTime = getState(soef.njs.dcs_old(deviceName, 'trans')) || 3;

    function aktStates() {
        return {
            r: getState(soef.njs.dcs_old(deviceName, 'r')),
            g: getState(soef.njs.dcs_old(deviceName, 'g')),
            b: getState(soef.njs.dcs_old(deviceName, 'b')),
            sat: getState(soef.njs.dcs_old(deviceName, 'sat'))
        };
    }

    devices.invalidate(id);

    switch (stateName) {
        case usedStateNames.transition.n:
            devices.setrawval(id, state.val);
            adapter.setState(id, state.val, true);
            // go through all devices and set trans to this value

            if (id === adapter.namespace + '.' + groupIdAll + '.' + usedStateNames.transition.n) {
                devices.foreach('*.trans', function (id) {
                    devices.setrawval(id, state.val);
                    adapter.setState(id, state.val, true);
                });
            }
            break;

        case 'refresh':
            updateDevices(mac);
            adapter.setState(id, false, true);
            break;

        case 'rgbw':
        case 'rgb':
            var colors = parseHexColors(state.val);
            colors.sat = colors.w !== undefined ? colors.w : getState(soef.njs.dcs_old(deviceName, 'sat'));
            //var bri = getBrightness(colors);
            //colors.sat = 0x80;
            lightify.nodeColor(mac, colors.r, colors.g, colors.b, colors.sat, transitionTime).then(function () {
                if (!isGroupId(mac) && (transitionTime / 10) < adapter.config.interval) {
                    setTimeout(updateDevices, transitionTime * 100, mac);
                }
            }).catch(onError);
            //lightify.nodeBrightness(mac, bri, 0).catch(onError);
            break;

        case 'on':
            lightify.nodeOnOff(mac, !!(state.val >> 0)).then(function () {
                if (isGroupId(mac)) {
                    adapter.setState(id, state.val, true);
                } else if ((transitionTime / 10) < adapter.config.interval) {
                    setTimeout(updateDevices, transitionTime * 100, mac);
                }
            }).catch(onError);
            break;

        case 'r':
        case 'g':
        case 'b':
        case 'sat':
            var ccolors;
            if (typeof state.val === 'string' && state.val[0] === '#') {
                ccolors = parseHexColors(state.val);
                ccolors.sat = ccolors.w !== undefined ? ccolors.w : getState(soef.njs.dcs_old(deviceName, 'sat'));
            } else {
                ccolors = aktStates();
                ccolors[stateName] = state.val >> 0;
            }
            lightify.nodeColor(mac, ccolors.r, ccolors.g, ccolors.b, ccolors.sat, transitionTime).then(function () {
                if (!isGroupId(mac) && (transitionTime / 10) < adapter.config.interval) {
                    setTimeout(updateDevices, transitionTime * 100, mac);
                }
            }).catch(onError);
            break;

        case 'bri':
            lightify.nodeBrightness(mac, state.val >> 0, transitionTime).then(function () {
                if (isGroupId(mac)) {
                    adapter.setState(id, state.val, true);
                    if (state.val >> 0) {
                        adapter.setState(groupIdAll + '.on', true, true);
                    } else {
                        adapter.setState(groupIdAll + '.on', false, true);
                    }
                } else if ((transitionTime / 10) < adapter.config.interval) {
                    setTimeout(updateDevices, transitionTime * 100, mac);
                }
            }).catch(onError);
            break;

        case 'ct':
            lightify.nodeTemperature(mac, state.val >> 0, transitionTime).then(function () {
                if (!isGroupId(mac) && (transitionTime / 10) < adapter.config.interval) {
                    setTimeout(updateDevices, transitionTime * 100, mac);
                }
            }).catch(onError);
            break;

        case 'command':
            //var v = state.val.replace(/^on$|red|green|blue|transition|bri|off|#/g, function(match) { return { '#': '#', of:'off:1', on:'on:1', red:'r', green:'g', blue:'b', white: 'w', transition:'x', bri:'l', off:'on:0'}[match] });
            var v = state.val.replace(/^on$|red|green|blue|transition|bri|off|false|#/g, function (match) {
                return {
                    'false': 0,
                    '#': '#',
                    of: 'off:1',
                    on: 'on:1',
                    red: 'r',
                    green: 'g',
                    blue: 'b',
                    white: 'w',
                    transition: 'x',
                    bri: 'l',
                    off: 'on:0'
                }[match]
            });
            v = v.replace(/\s|"|;$|,$/g, '').replace(/=/g, ':').replace(/;/g, ',').replace(/true/g, 1).replace(/#((\d|[a-f]|[A-F])*)/g, 'h:"$1"').replace(/(r|g|b|w|x|l|sat|of|on|ct|h)/g, '"$1"').replace(/^\{?(.*?)\}?$/, '{$1}');
            var colors_;
            try {
                colors_ = JSON.parse(v);
            } catch (e) {
                adapter.log.error('on Command: ' + e.message + ': state.val="' + state.val + '"');
                return;
            }
            if (colors_.h !== undefined) {
                //var co = parseHexColors('#'+colors_.h);
                var co = parseHexColors(colors_.h);
                colors_.r = co.r;
                colors_.g = co.g;
                colors_.b = co.b;
                delete colors_.h;
            }

            if (!colors_ || typeof colors_ !== 'object') {
                return;
            }

            var obj = soef.njs.fullExtend(aktStates(), colors_);
            adapter.log.debug(JSON.stringify(obj));
            if (obj.x !== undefined) {
                transitionTime = obj.x >> 0;
            }
            if (colors_.r !== undefined || colors_.g !== undefined || colors_.b !== undefined || colors_.sat !== undefined) {
                lightify.nodeColor(mac, obj.r, obj.g, obj.b, obj.sat, transitionTime).catch(onError);
            }
            if (obj['on'] !== undefined) {
                lightify.nodeOnOff(mac, !!(obj.on >> 0)).catch(onError);
            }
            if (obj['ct'] !== undefined) {
                lightify.nodeTemperature(mac, obj.ct >> 0, transitionTime).catch(onError);
            }
            if (obj['l'] !== undefined) {
                lightify.nodeBrightness(mac, obj.l >> 0, transitionTime).catch(onError);
            }
            break;

        default:
            return
    }

    setTimeout(updateDevices, 800, mac);

    if (transitionTime * 100 > 800) {
        setTimeout(updateDevices, transitionTime * 100, mac);
    }
}

var tf = {
    BRI:    0xAE, // ((~FT_SWITCH) & (~FT_PLUG)) & 0xff, //0xffee,   // 0x04?
    CT:     0x02,
    RGB:    0x08,
    SWITCH: 0x40,
    PLUG:   0x10,
    LIGHT:  0xAE,
    ALL:    0xFF
};

var usedStateNames = {
    type:        {n: 'type',      g: 1, tf: tf.ALL,   val: 0, common: {read: true, min: 0, max: 255, write: false, type: 'number', role: 'state'}},
    online:      {n: 'reachable', g: 1, tf: tf.ALL,   val: 0, common: {read: true, write: false, type: 'boolean', role: 'indicator.connected'}},
    groupid:     {n: 'groupid',   g: 1, tf: tf.ALL,   val: 0, common: {read: true, write: false, type: 'string', role: 'state'}},
    status:      {n: 'on',        g: 7, tf: tf.ALL,   val: false, common: {read: true, write: false, type: 'boolean', role: 'switch'}},
    brightness:  {n: 'bri',       g: 3, tf: tf.BRI,   val: 0, common: {read: true, write: true, min: 0, max: 100, unit: '%', desc: '0..100%', type: 'number', role: 'level.dimmer'}},
    temperature: {n: 'ct',        g: 3, tf: tf.CT,    val: 0, common: {read: true, write: true, min: 2700, max: 6500, unit: '°K', desc: 'in °Kelvin 2700..6500', type: 'number', role: 'level.color.temperature'}},
    red:         {n: 'r',         g: 3, tf: tf.RGB,   val: 0, common: {read: true, write: true, min: 0, max: 255, type: 'number', role: 'level.color.red'}},
    green:       {n: 'g',         g: 3, tf: tf.RGB,   val: 0, common: {read: true, write: true, min: 0, max: 255, type: 'number', role: 'level.color.green'}},
    blue:        {n: 'b',         g: 3, tf: tf.RGB,   val: 0, common: {read: true, write: true, min: 0, max: 255, type: 'number', role: 'level.color.blue'}},
    alpha:       {n: 'sat',       g: 3, tf: tf.RGB,   val: 0, common: {read: true, write: true, min: 0, max: 255, type: 'number', role: 'level.color.saturation'}},
    transition:  {n: 'trans',     g: 3, tf: tf.LIGHT, val: 30,common: {read: true, write: false, unit: '\u2152 s', desc: 'in 10th seconds', type: 'number', role: 'state'} },

    command:     {n: 'command',   g: 3, tf: tf.LIGHT, val: 'r:0, g:0, b:0, sat:255, on:true, transition:20', common: {read: true, write: true, type: 'string', role: 'state'}},
    refresh:     {n: 'refresh',   g: 1, tf: tf.LIGHT, val: false, common: {desc: 'read states from device', type: 'boolean', role: 'button'}},
    rgb:         {n: 'rgb',       g: 3, tf: tf.RGB,   val: '',    common: {desc: '#000000..#ffffff', type: 'string', role: 'level.color.rgb'}}

};


var F_DEVICE = 1;
var F_GROUP  = 2;
var F_ALL    = 4;

var groupSuffix     = '00000000000000';
//var _00000000000000 = '00000000000000';
var groupIdAll      = 'FFFFFFFFFFFFFFFF';

function isGroupId(id) {
    if (!id || id.length < groupSuffix.length + 2) {
        return false;
    }
    return id === groupIdAll || id.substr(2) === groupSuffix;
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
function createAll(callback) {

    var dev = new devices.CDevice(0, '');
    var existingDevices = [];

    function create(data, gFlag) {
        for (var i = 0; i < data.result.length; i++) {
            var device = data.result[i];
            existingDevices.push(device.mac);
            //dev.setDevice(device.mac, {common: {name: device.name, role: gFlag&F_DEVICE?'Device':'Group'}, native: { mac: device.mac, groups: device.groupid } });
            dev.setChannel(device.mac, {
                common: {
                    name: device.name,
                    role: gFlag & F_DEVICE ? 'Device' : 'Group'
                },
                native: {
                    mac: device.mac,
                    groups: device.groupid
                }
            });
            for (var j in usedStateNames) {
                if (usedStateNames[j].g & gFlag && (gFlag & F_GROUP) || (device.type & usedStateNames[j].tf)) {
                    if (isGroupId(device.mac)) {
                        // all does not supported rgb
                        if (usedStateNames[j].n === 'rgb' ||
                            usedStateNames[j].n === 'r'   ||
                            usedStateNames[j].n === 'g'   ||
                            usedStateNames[j].n === 'b'   ||
                            usedStateNames[j].n === 'ct'  ||
                            usedStateNames[j].n === 'sat' ||
                            usedStateNames[j].n === 'command') continue;
                    }
                    var st = Object.assign({}, usedStateNames[j]);
                    dev.createNew(st.n, st);
                }
            }
        }
    }

    function checkDeletedDevices() {
        devices.foreach('*', function (id) {
            if (id.indexOf('.') >= 0 || id === 'refresh'/*|| isGroupId(id)*/) {
                return true;
            }
            if (!existingDevices.find(function (v) {
                    return v === id;
                })) {
                soef.njs.dcs_old(id);
            }
            return true;
        });

    }

    lightify.discover().then(function (data) {
        create(data, F_DEVICE);
        create({
            result: [
                {mac: groupIdAll, name: 'All'}
            ]
        }, F_GROUP);

        lightify.discoverZone().then(function (data) {

            for (var i = 0; i < data.result.length; i++) {
                data.result[i].mac = soef.sprintf('%02x00000000000000', data.result[i].id);
            }
            create(data, F_GROUP);
            //devices.update(callback);
            checkDeletedDevices();

            dev.update(function () {
                devices.root.set('refresh', usedStateNames.refresh);
                devices.update(callback);
            });
        }).catch(onError);
    }).catch(onError);
}

function updateDevices(mac) {

    function update(data) {
        var g = 1;
        if (!data.result) {
            data = {
                result: [data]
            };
        }
        var dev = new devices.CDevice(0, '');
        for (var i = 0; i < data.result.length; i++) {
            var device = data.result[i];
            if (device.status !== undefined) {
                device.status = !!device.status;
            }
            if (device.type) {
                types[device.mac] = device.type;
            }
            dev.setChannel(device.mac); //, device.name ? {common: {name: device.name}} : undefined); //, {common: {name: device.name}});
            dev.setName(device.name);

            var o = {};
            o.bri = device.brightness; // * 10;// * 2560;
            o.red = Math.round((device.red * o.bri) / 100);
            o.green = Math.round((device.green * o.bri) / 100);
            o.blue = Math.round((device.blue * o.bri) / 100);
            device.rgb = soef.sprintf('#%02X%02X%02X', o.red, o.green, o.blue, device.alpha);

            device.type = device.type || types[device.mac];

            for (var j in usedStateNames) {
                if (usedStateNames[j].g & g && device[j] !== undefined && (device.type & usedStateNames[j].tf)) {
                    dev.set(usedStateNames[j].n, device[j]);
                }
            }
        }
        dev.update();
    }

    if (mac && lightify.getStatus !== undefined && !isGroupId(mac)) {
        lightify.getStatus(mac).then(update).catch(onError);
    } else {
        lightify.discover().then(update).catch(onError);
    }
}

function poll() {
    updateDevices();
    if (!adapter.config.polling || adapter.config.interval <= 0) {
        return;
    }
    updateTimer.set(poll, adapter.config.interval * 1000);
}

function browse(callback) {
    var ips = getIPAddresses();
    var result = [];
    if (!ips.length) {
        return callback && callback([]);
    }
    var count = 0;
    ips.forEach(function (ownIP) {
        var prefixIP = ownIP.split('.', 3).join('.') + '.';
        adapter.log.info('Own IP: ' + ownIP + ' Range: ' + prefixIP + '1...255');
        for (var i = 0; i < 255; i++) {
            count++;
            tryIp(prefixIP + i, function (foundIp) {
                if (foundIp) {
                    result.push(foundIp);
                }
                if (!--count && callback) {
                    callback(result);
                }
            });
        }
    });
}

function getIPAddresses() {
    // found on stackOverflow
    var ips = [];
    var interfaces = require('os').networkInterfaces();
    for (var devName in interfaces) {
        if (!interfaces.hasOwnProperty(devName)) continue;

        var iface = interfaces[devName];

        for (var i = 0; i < iface.length; i++) {
            var alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                ips.push(alias.address);
            }
        }
    }
    return ips;
}

function tryIp(ip, cb) {
    net = net || require('net');

    var client = new net.Socket();
    client.setTimeout(1000, function () {
        try {
            client.destroy();
        } catch (e) {

        }
        cb(null);
    });

    client.on('data', function (data) {
    });

    client.on('error', function (error) {
        try {
            client.destroy();
        } catch (e) {

        }
        cb(null);
    });

    client.on('connect', function () {
        try {
            client.end();
        } catch (e) {

        }
        cb(ip);
    });
    client.connect(4000, ip, function () {
    });
}

function checkIP(callback) {
    if (adapter.config.ip) {
        return callback();
    }

    adapter.log.info('No IP configured, trying to find a gateway...');
    browse(function (list) {
        if (list && list.length) {
            adapter.log.info('Found IP: ' + list[0]);

            adapter.getForeignObject('system.adapter.' + adapter.namespace, function (err, obj) {
                obj.native.ip = list[0];
                adapter.setForeignObject(obj._id, obj, {}, function (err, obj) {
                    // Wait till adapter will be restarted
                    process.exit();
                });
            });
        } else {
            adapter.log.warn('No IP defined and nothing found');
        }
    });
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function normalizeConfig(config) {
    config.interval = config.interval >> 0; // same as parseInt()
    config.polling  = !!config.polling;
}

var errorCnt = 0;
var oTimeout;
function onError(error) {
    switch (error.errno) { //error.code
        //case undefined:
        //    if (error.message != "This socket is closed") return;
        case 'ETIMEDOUT':
        case 'ECONNRESET':
        case 'EPIPE':
            if (oTimeout) clearTimeout(oTimeout);
            oTimeout = setTimeout(start, 3000);
            if (connected) {
                adapter.setState('info.connection', false, true);
                connected = false;
            }
            return;
    }
    if (error === 'timeout') {
        if (oTimeout) clearTimeout(oTimeout);
        oTimeout = setTimeout(start, 3000);
        if (connected) {
            adapter.setState('info.connection', false, true);
            connected = false;
        }
    }
}
function onConnectError(err) {
    if (err === 'timeout') {
        setTimeout(start, errorCnt <= 5 ? 1000 : 10000);
        if (errorCnt++ === 5) {
            adapter.log.error('Can not connect to Lightify Gateway "' + adapter.config.ip + '"');
        }
        if (connected) {
            adapter.setState('info.connection', false, true);
            connected = false;
        }
    }
}

function start() {
    updateTimer.clear();
    if (lightify) {
        lightify.dispose();
        lightify = null;
    }
    lightify = new Lightify.lightify(adapter.config.ip, adapter.log, onError);

    lightify.connect(onError).then(function () {
        adapter.setState('info.connection', true, true);
        errorCnt = 0;
        createAll(poll);
    }).catch(onConnectError);
}

function main() {
    normalizeConfig(adapter.config);
    adapter.setState('info.connection', false, true);
    checkIP(function () {
        start();
        adapter.subscribeStates('*');
    });
}

/*
 type  2: SurfaceTW, LIGHTIFY Surface Light Turable White
 type 10: A60RGBW, LIGHTIFY CLA 60 RGBW
 type  4: SurfaceW, LIGHTIFY Surface Light W 28
 */

//https://api.github.com/repos/soef/node-lightify/tarball/master