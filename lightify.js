"use strict";

var utils = require(__dirname + '/lib/utils'),
    soef = require(__dirname + '/lib/soef'),
    devices = new soef.Devices();

var lightify = require('node-lightify');


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


function mac2Str(mac) {
    var bmac = new Buffer(9);
    bmac[8] = 0;
    bmac.writeDoubleLE(mac, 0);
    return bmac.toString('hex');
}

function str2Mac(str) {
    var bmac = new Buffer(str, 'hex');
    return bmac.readDoubleLE(0, 8);
}

function getState(id, state) {
    //var s = id.replace(/\w+$/, state);
    //var s = id.replace(/\w+$/, '');
    var o = devices.get(id);
    if (o === undefined) return undefined;
    return o.val || 0;
}


function stateChange(id, state) {
    var ar = id.split('.');
    if (!devices.has(ar[2])) {
        adapter.log("Unknown device " + ar[2]);
        return;
    }

    var mac = str2Mac(ar[2]);
    var transitionTime = getState(dcs(ar[2], 'tans')) || 3;
    //var parent = id.replace(/\w+$/, '');

    switch (ar[3]) {
        case 'on':
            lightify.node_on_off(mac, state.val >> 0 ? true : false);
            break;
        case 'r':
        case 'g':
        case 'b':
        case 'sat':
            var colors = {
                r: getState(dcs(ar[2], 'r')),
                g: getState(dcs(ar[2], 'g')),
                b: getState(dcs(ar[2], 'b')),
                sat: getState(dcs(ar[2], 'sat'))
            };
            colors[ar[3]] = state.val >> 0;
            //console.log(JSON.stringify(colors));
            lightify.node_color(mac, colors.r, colors.g, colors.b, colors.sat, transitionTime);
            break;
        case 'bri':
            lightify.node_brightness(mac, state.val >> 0, transitionTime);
            break;
        case 'ct':
            lightify.node_temperature(mac, state.val >> 0, transitionTime);
            break;
        default:
            return
    }
    setTimeout(updateDevices, 200);
}

var usedStateNames = {
    type:        { n: 'type',      val: 0, common: { min: 0, max: 255, write: false }},
    online:      { n: 'reachable', val: false, common: { min: false, max: true, write: false }},
    groupid:     { n: 'groupid',   val: 0, common: { write: false }},
    status:      { n: 'on',        val: false, common: { min: false, max: true }},
    brightness:  { n: 'bri',       val: 0, common: { min: 0, max: 100 }},
//    temperature: { n: 'ct',        val: 0, common: { min: 0, max: 5000 }},
    red:         { n: 'r',         val: 0, common: { min: 0, max: 255 }},
    green:       { n: 'g',         val: 0, common: { min: 0, max: 255 }},
    blue:        { n: 'b',         val: 0, common: { min: 0, max: 255 }},
    alpha:       { n: 'sat',       val: 0, common: { min: 0, max: 255 }},
    transition:  { n: 'trans',     val: 3 }
};


function createDevices (data, callback) {
    var dev = new devices.CDevice(0, '');
    for (var i=0; i<data.result.length; i++) {
        var device = data.result[i];
        dev.setDevice(mac2Str(device.mac), { common : { name: device.name}});
        for (var j in usedStateNames) {
            var st = Object.assign ({}, usedStateNames[j]);
            dev.set (st.n, st);
        }
    }
    devices.update(callback);
}

function updateDevices () {
    lightify.discovery().then(function(data) {
        var dev = new devices.CDevice(0, '');
        for (var i = 0; i < data.result.length; i++) {
            var device = data.result[i];
            dev.setDevice(mac2Str(device.mac), {common: {name: device.name}});
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
        return lightify.discovery();
    }).then(function(data) {
        createDevices(data, poll);
    });

    adapter.subscribeStates('*');
}

