// Taken from here https://github.com/rainlake/node-lightify
// because license file is MIT and in package.json is BSD. No idea which license to take...
// 
// Copyright (c) 2015 Timon Reinhard and contributors

var net = require('net');
var moment = require('moment');
var Promise = require('promise');

const
    COMMAND_LIST_ALL_NODE = 0x13,
    COMMAND_LIST_ALL_ZONE = 0x1E,
    COMMAND_BRIGHTNESS = 0x31,
    COMMAND_ONOFF = 0x32,
    COMMAND_TEMP = 0x33,
    COMMAND_COLOR = 0x36,

    COMMAND_SOFT_ON = 0xDB,
    COMMAND_SOFT_OFF = 0xDC,
    COMMAND_GET_ZONE_INFO = 0x26,
    COMMAND_GET_STATUS = 0x68,
    COMMAND_ACTIVATE_SCENE = 0x52;

const commands = {
    0x13: 'COMMAND_LIST_ALL_NODE',
    0x1E: 'COMMAND_LIST_ALL_ZONE',
    0x31: 'COMMAND_BRIGHTNESS',
    0x32: 'COMMAND_ONOFF',
    0x33: 'COMMAND_TEMP',
    0x36: 'COMMAND_COLOR',
    0xDB: 'COMMAND_SOFT_ON',
    0xDC: 'COMMAND_SOFT_OFF',
    0x26: 'COMMAND_GET_ZONE_INFO',
    0x68: 'COMMAND_GET_STATUS',
    0x52: 'COMMAND_ACTIVATE_SCENE'
};
const errors = {
    0x00: 'No error',
    0x01: 'Wrong (number of) parameter(s)',
    0x15: 'Command is not a broadcast',
    0xFF: 'Unknown command'
};

Buffer.prototype.getOurUTF8String = function (start, end) {
    for (var i = start; i < end && this[i] !== 0; i++) {
    }
    return this.toString('utf-8', start, i);
};

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// use this to get & set the mac-value as hex string
/*
 Buffer.prototype.writeDoubleLE1 = function (val, pos) {
 return this.write(val.toLowerCase(), 0, 8, 'hex');
 };
 Buffer.prototype.readDoubleLE1 = function (pos, len) {
 return this.toString('hex', pos, len === undefined ? undefined : pos+len).toUpperCase();
 };
 */
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


function defaultBuffer(mac, len) {
    if (len === undefined) len = 9;
    var body = new Buffer(len);
    body.fill(0);
    if (typeof mac === 'string') {
        body.write(mac.substr(0, 16), 0, 'hex');
    } else {
        body.writeDoubleLE(mac, 0);
    }
    return body;
}

/*function isBigEndian() {
    var a = new Uint32Array([0x12345678]);
    var b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    return (b[0] === 0x12);
}*/
var seq = 0;

var lightify = function (ip, logger, onError) {
    this.ip = ip;
    this.commands = [];
    this.logger = logger;
    this.onError = onError;

    this.groupCommands = [
        COMMAND_BRIGHTNESS,
        COMMAND_ONOFF,
        COMMAND_TEMP,
        COMMAND_COLOR,
        COMMAND_GET_STATUS
    ];
    this.groupIdAll = 'FFFFFFFFFFFFFFFF';
    this.groupSuffix = '00000000000000';

    this.sendNextRequest = this.sendNextRequestNormal;
    this.connectErrorCount = 0;
};
lightify.prototype.processData = function (cmd, data, code) {
    var fail = data.readUInt8(8);
    if (fail && cmd.reject) {
        this.logger && this.logger.warn('Command ' + (commands[code] || '0x' + code.toString(16)) + ' failed: ' + (errors[fail] || '0x' + fail.toString(16)));
        return cmd.reject({
            cmd: cmd,
            fail: fail,
            response: data.toString('hex')
        });
    }
    var num = data.readUInt16LE(9);
    var result = {result: []};
    var packageSize = cmd.packageSize || (num && (data.length - 11) / num);
    for (var i = 0; i < num; i++) {
        var pos = 11 + i * packageSize;
        result.result.push(cmd.cb(data, pos));
    }
    result.request = cmd.request;
    result.response = data.toString('hex');
    if (cmd.resolve) {
        cmd.resolve(result);
    }
};

lightify.prototype.connect = function () {
    var self = this;

    return new Promise(function (resolve, reject) {
        self.client = new net.Socket();
        self.connectTimeout = setTimeout(function () {
            reject('connect timeout');
            self.logger && self.logger.debug('can not connect to lightify bridge, timeout');
            self.client.destroy();
        }, 4000);
        self.client.on('data', function (data) {
            self.logger && self.logger.debug('socket data: [' + data.toString('hex') + ']');
            if (self.readBuffer && self.readBuffer.length) {
                data = Buffer.concat([self.readBuffer, data]);
            }
            var expectedLen = data.readUInt16LE(0) + 2;
            self.logger && self.logger.debug('Expected len [' + expectedLen + ']');
            self.logger && self.logger.debug('len = [' + data.length + ']');
            if (expectedLen > data.length) {
                self.readBuffer = new Buffer(data); // I think you can use data directly (without new Buffer())
                return;
            } else if (expectedLen === data.length) {
                self.readBuffer = undefined;
            } else {
                self.readBuffer = new Buffer(data.slice(data.length - expectedLen));
            }
            self.onData(data);
        });
        self.client.on('error', function (error) {
            self.onError(error);
        });
        self.client.connect(4000, self.ip, function () {
            clearTimeout(self.connectTimeout);
            resolve();
        });
    });
};

lightify.prototype.onData = function (data) {
    var seq = data.readUInt32LE(4);
    var cmd = data.readUInt8(3);
    this.logger && this.logger.debug('got response for seq ' + (commands[cmd] || '0x' + cmd.toString(16)) + ' [' + seq + '][' + data.toString('hex') + ']');
    var now = new Date().getTime();
    var isSend = false;
    for (var i = this.commands.length - 1; i >= 0; i--) {
        if (this.commands[i].seq === seq) {
            if (this.commands[i].timer) clearTimeout(this.commands[i].timer);
            this.logger && this.logger.debug('found request');
            this.processData(this.commands[i], data, cmd);
            this.commands.splice(i, 1);
            isSend = true;
        } else if (now - this.commands[i].stated > 10000) {
            // clear too old commands to avoid memory leaks
            this.logger && this.logger.warn('delete too old command');
            if (this.commands[i].timer) clearTimeout(this.commands[i].timer);
            this.commands.splice(i, 1);
            isSend = true;
        }
    }

    if (isSend) {
        this.sendNextRequest();
    }
};

lightify.prototype.dispose = function () {
    this.commands = [];
    this.client.destroy();
    if (this.buffers) this.buffers.length = 0;
    this.client.connected = undefined;
};

lightify.prototype.onError = function (error) {
    this.logger && this.logger.debug('connection has error', error);
    for (var i = 0; i < this.commands.length; i++) {
        if (this.commands[i]) {
            if (this.commands[i].timer) {
                clearTimeout(this.commands[i].timer);
                this.commands[i].timer = null;
            }
            if (this.commands[i].reject) {
                this.commands[i].reject(error);
            }
        }
    }
    // clear buffer
    this.commands = [];
    this.dispose();
    this.onError && this.onError(error);
};

lightify.prototype.setDisconnectTimer = function () {
    var self = this;

    var _setTimer = function () {
        if (self.disconnectTimer) clearTimeout(self.disconnectTimer);
        self.disconnectTimer = setTimeout(function () {
            self.disconnectTimer = undefined;
            if (self.buffers.length) return _setTimer();
            self.client.end();
            self.client.connected = undefined;
            self.logger && self.logger.debug('setDisconnectTimer: client.end() called');
        }, self.timeToStayConnected);
    };
    if (!self.disconnectTimer || !self.buffers.length) _setTimer();
};

lightify.prototype.sendNextRequestNormal = function (buffer) {
    if (buffer) this.client.write(buffer); // to overwrite it to use serialization
};

lightify.prototype.sendNextRequestAutoClose = function (buffer) {
    var self = this;
    var nextTimer;

    var checkSend = function () {
        switch (self.client.connected) {
            case false:
                break;
            case true:
                if (self.buffers.length > 0) {
                    self.client.write(self.buffers.shift());
                    self.logger && self.logger.debug('sendNextRequest: sent buffer done, remaining length=' + self.buffers.length);
                    if (self.buffers.length) {
                        if (nextTimer) clearTimeout(nextTimer);
                        nextTimer = setTimeout(checkSend, 1000);
                    }
                }
                break;
            case undefined:
                self.client.connected = false;
                self.logger && self.logger.debug('sendNextRequest: trying to connect');
                //self.client.connect (4000, self.ip, function () {
                self.connectEx(function () {
                    self.logger && self.logger.debug('sendNextRequest: connected! buffers.length=' + self.buffers.length);
                    checkSend();
                });
                break;
        }
    };

    if (buffer) {
        this.buffers = this.buffers || [];
        self.logger && self.logger.debug('sendNextRequest: push(buffer) length=' + (this.buffers.length + 1));
        this.buffers.push(buffer);
    } else {
        if (nextTimer) clearTimeout(nextTimer);
        nextTimer = undefined;
        this.setDisconnectTimer();
    }
    checkSend();
};

lightify.prototype.setAutoCloseConnection = function (on) {
    if (on) {
        if (this.timeToStayConnected === undefined) this.timeToStayConnected = 3000;
        this.buffers = this.buffers || [];
        this.buffers.length = 0;
        this.sendNextRequest = this.sendNextRequestAutoClose;
    } else {
        delete this.buffers;
        this.sendNextRequest = this.sendNextRequestNormal;
    }
};

lightify.prototype.connectEx = function (cb, errorCb) {
    var self = this;

    function func() {
        self.connectErrorCount = 0;
        self.client.connected = true;
        cb && cb();
    }

    if (!this.client) { // || this.client.destroyed || !this.client.readable) {
        return this.connect().then(func).catch(function (error) {
            if (self.connectErrorCount++ < 5) setTimeout(function () {
                self.client = undefined;
                self.connectEx(cb);
            }, 1000 * self.connectErrorCount);
            else {
                errorCb && errorCb('Can not connect to Lightify Gateway ' + self.ip, error);
                self.logger && self.logger.debug('Can not connect to Lightify Gateway ' + self.ip);
            }
        });
    }
    return this.client.connect(4000, self.ip, func);
};


lightify.prototype.isGroup = function (mac) {
    if (!mac || mac.length < this.groupSuffix.length + 2) {
        return false;
    }
    return mac === this.groupIdAll || mac.substr(2) === this.groupSuffix;
};

lightify.prototype.isGroupCommand = function (cmdId, body) {
    if (this.groupCommands.indexOf(cmdId) >= 0) {
        // in case mac was not a string (in your case the group-id). Otherwise this function is overwritable
        //for (var i = 0; i < 7 && body[i] === 0; i++);
        //if (i === 6) return 2;
        if (this.isGroup(body.readDoubleLE(0, 8))) return 2;
        // for (var i = 1; i < 8 && body[i] === 0; i++); // depends on discoverZone
        // if (i === 8) return 2;
    }
    return 0;
};

lightify.prototype.sendCommand = function (cmdId, body, flag, cb, packageSize) {
    var self = this;
    if (typeof flag === 'function') {
        cb = flag;
        flag = undefined;
    }
    if (flag === undefined) {
        flag = this.isGroupCommand(cmdId, body);
    }
    this.logger && this.logger.debug('Send command ' + (commands[cmdId] || '0x' + cmdId.toString(16)) + ', seq: ' + (seq + 1));

    return new Promise(function (resolve, reject) {
        var buffer = new Buffer(8 + body.length);

        buffer.fill(0);
        buffer.writeUInt16LE(8 + body.length - 2, 0);// length
        buffer.writeUInt8(flag || 0x00, 2);          // Flag, 0:node, 2:zone
        buffer.writeUInt8(cmdId, 3);                   // command
        buffer.writeUInt32LE(++seq, 4);              // request id
        body.copy(buffer, 8);
        var cmd = {
            seq: seq,
            createTime: moment().format('x'),
            resolve: resolve,
            reject: reject,
            packageSize: packageSize,
            cb: (cb || function (data, pos) {
                return {
                    mac: data.readDoubleLE(pos, 8),
                    friendlyMac: data.toString('hex', pos, pos + 8),
                    success: data.readUInt8(pos + 8)
                };
            }),
            request: buffer.toString('hex'),
            stated: new Date().getTime()
        };
        cmd.timer = setTimeout(function () {
            cmd.timer = null;
            self.logger && self.logger.debug('send command timeout [' + cmd.seq + '][' + buffer.toString('hex') + ']');
            cmd.reject('timeout');
            cmd.resolve = undefined;
            cmd.reject = undefined;

            // delete it from commands
            for (var i = 0; i < self.commands.length; i++) {
                if (self.commands[i].seq === cmd.seq) {
                    self.commands.splice(i, 1);
                    break;
                }
            }
            self.sendNextRequest();
        }, 2000);
        self.logger && self.logger.debug('command sent [' + cmd.seq + '][' + buffer.toString('hex') + ']');
        self.commands.push(cmd);
        self.sendNextRequest(buffer);
    });
};

lightify.prototype.discover = function () {
    return this.sendCommand(COMMAND_LIST_ALL_NODE, new Buffer([0x1]), function (data, pos) {
        return {
            id: data.readUInt16LE(pos),
            mac: data.readDoubleLE(pos + 2, 8),
            friendlyMac: data.toString('hex', pos + 2, pos + 10),
            type: data.readUInt8(pos + 10),
            firmware_version: data.readUInt32BE(pos + 11),
            online: data.readUInt8(pos + 15),
            groupid: data.readUInt16LE(pos + 16),
            status: data.readUInt8(pos + 18), // 0 == off, 1 == on
            brightness: data.readUInt8(pos + 19),
            temperature: data.readUInt16LE(pos + 20),
            red: data.readUInt8(pos + 22),
            green: data.readUInt8(pos + 23),
            blue: data.readUInt8(pos + 24),
            alpha: data.readUInt8(pos + 25),
            name: data.getOurUTF8String(pos + 26, pos + 50)
        };
    }, 50);
};

lightify.prototype.discoverZone = function () {
    return this.sendCommand(COMMAND_LIST_ALL_ZONE, new Buffer([0x0]), 2, function (data, pos) {
        var id = data.readUInt16LE(pos);
        var buffer = new Buffer(8);
        buffer.fill(0);
        buffer.writeUInt16LE(id, 0);
        return {
            id: id,
            mac: buffer.readDoubleLE(0), // use id as mac
            name: data.getOurUTF8String(pos + 2, pos + 18)
        };
    });
};

lightify.prototype.nodeOnOff = function (mac, on, isGroup) {
    var body = defaultBuffer(mac);
    body.writeUInt8(on ? 1 : 0, 8);
    return this.sendCommand(COMMAND_ONOFF, body, isGroup !== undefined ? isGroup ? 0x2 : 0 : undefined);
};

lightify.prototype.nodeSoftOnOff = function (mac, on, transitiontime) {
    var body = defaultBuffer(mac, 10);
    body.writeUInt16LE(transitiontime || 0, 8);
    return this.sendCommand(on ? COMMAND_SOFT_ON : COMMAND_SOFT_OFF, body);
};

lightify.prototype.activateScene = function (sceneId) {
    var body = new Buffer(2);
    body.writeUInt8(sceneId, 0);
    body.writeUInt8(0, 1);
    return this.sendCommand(COMMAND_ACTIVATE_SCENE, body);
};

lightify.prototype.getZoneInfo = function (zone) {
    var body = new Buffer(2);
    body.writeUInt16LE(zone, 0);
    return this.sendCommand(COMMAND_GET_ZONE_INFO, body, 2,
        function (data, pos) {
            if (data.length < pos+15) {
                return {};
            }
            var o = {
                groupNo: zone,
                name: data.getOurUTF8String(pos, pos + 15),
                devices: []
            };
            var cnt = data.readUInt8(pos + 16);
            for (var i = 0; i < cnt; i++) {
                var ipos = pos + 17 + i * 8;
                o.devices.push(data.readDoubleLE(ipos, 8));
            }
            return o;
        }
    );
};

lightify.prototype.discoverZoneEx = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
        self.discoverZone ().then (function (data) {
            var i = 0;
        
            (function next () {
                if (i >= data.result.length) return resolve(data);
                var zone = data.result[i++];
                self.getZoneInfo (zone.id).then (function (info) {
                    zone.devices = info.result[0].devices;
                    next ();
                }).catch(reject);
            })();
        }).catch(reject);
    })
};


lightify.prototype.getStatus = function (mac) {
    var body = defaultBuffer(mac, 8);
    return this.sendCommand(COMMAND_GET_STATUS, body, function (data, pos) {
        var o = {
            mac: data.readDoubleLE(11, 8),
            requestStatus: data.readUInt8(19),
            online: 0
        };
        if (o.requestStatus === 0x00) { //0xFF) {
            o.online = data.readUInt8(20);
            o.status = data.readUInt8(21);
            o.brightness = data.readUInt8(22);
            o.temperature = data.readUInt16LE(23);
            o.red = data.readUInt8(25);
            o.green = data.readUInt8(26);
            o.blue = data.readUInt8(27);
            o.alpha = data.readUInt8(28);
        }
        return o;
    }).then(function (device) {
        return Promise.resolve(device.result.length && device.result[0]);
    });
};

lightify.prototype.nodeBrightness = function (mac, brightness, stepTime) {
    var buffer = defaultBuffer(mac, 11);
    buffer.writeUInt8(brightness, 8);
    buffer.writeUInt16LE(stepTime || 0, 9);
    return this.sendCommand(COMMAND_BRIGHTNESS, buffer);
};

lightify.prototype.nodeTemperature = function (mac, temperature, stepTime) {
    var buffer = defaultBuffer(mac, 12);
    buffer.writeUInt16LE(temperature, 8);
    buffer.writeUInt16LE(stepTime || 0, 10);
    return this.sendCommand(COMMAND_TEMP, buffer);
};

lightify.prototype.nodeColor = function (mac, red, green, blue, alpha, stepTime) {
    var buffer = defaultBuffer(mac, 14);
    buffer.writeUInt8(red, 8);
    buffer.writeUInt8(green, 9);
    buffer.writeUInt8(blue, 10);
    buffer.writeUInt8(alpha, 11);
    buffer.writeUInt16LE(stepTime || 0, 12);

    return this.sendCommand(COMMAND_COLOR, buffer);
};

function getNodeType(type) {
    return isPlug(type) ? 16 : type;
}

var tf = {
    ONOFF_LIGHT: 0x01,
    COLORTEMP_DIMMABLE_LIGHT: 0x02,
    DIMMABLE_LIGHT: 0x04,
    COLOR_LIGHT: 0x08,
    EXT_COLOR_LIGHT: 0x0A,
    PLUG: 0x10,
    SENSOR: 0x20,
    TWO_BTN_SWITCH: 0x40,
    FOUR_BTN_SWITCH: 0x41,
    BRI: 0xAE, // ((~FT_SWITCH) & (~FT_PLUG)) & 0xff, //0xffee,
    ALL: 0xFF,
    LIGHT: 0xAE
};
function isSwitch(type) {
    return type === tf.TWO_BTN_SWITCH || type === tf.FOUR_BTN_SWITCH;
}
function isPlug(type) {
    return type === tf.PLUG;
}
function isSensor(type) {
    return type === tf.SENSOR;
}
var exports = module.exports = {
    lightify: lightify,
    isPlug: isPlug,
    isSwitch: isSwitch,
    isSensor: isSensor,
    is2BSwitch: function (type) {
        return type === tf.TWO_BTN_SWITCH;
    },
    is4BSwitch: function (type) {
        return type === tf.FOUR_BTN_SWITCH;
    },
    isBrightnessSupported: function (type) {
        return getNodeType(type) === tf.COLORTEMP_DIMMABLE_LIGHT ||
            getNodeType(type) === tf.DIMMABLE_LIGHT ||
            (!isPlug(type) && getNodeType(type) !== tf.ONOFF_LIGHT);
    },
    isTemperatureSupported: function (type) {
        return getNodeType(type) === tf.COLORTEMP_DIMMABLE_LIGHT ||
            getNodeType(type) === tf.EXT_COLOR_LIGHT;
    },
    isColorSupported: function (type) {
        return getNodeType(type) === tf.EXT_COLOR_LIGHT ||
            getNodeType(type) === tf.COLOR_LIGHT;
    },
    isLight: function (type) {
        return !isSwitch(type) && !isPlug(type) && !isSensor(type);
    },
    tf: tf
};


