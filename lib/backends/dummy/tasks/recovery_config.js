
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * This task stage/activate the given recovery configuration into
 * a CN using EDAR (i.e. zpool encryption must be true)
 *
 * Dummy backend version.
 */


var crypto = require('crypto');

var assert = require('assert-plus');
var vasync = require('vasync');
var bunyan = require('bunyan');
var dns = require('dns');
var restify = require('restify');

var common = require('../common');
var shared = require('./shared');
var Task = require('../../../task_agent/task');

function sha512str(str) {
    const hash = crypto.createHash('sha512');
    hash.update(str);
    return hash.digest();
}

function repeatableUUIDFromHexString(hexStr) {
    var buf = Buffer.from(hexStr, 'hex');
    // variant:
    buf[8] = buf[8] & 0x3f | 0xa0;
    // version:
    buf[6] = buf[6] & 0x0f | 0x50;
    var hex = buf.toString('hex', 0, 16);
    const uuid = [
        hex.substring(0, 8),
        hex.substring(8, 12),
        hex.substring(12, 16),
        hex.substring(16, 20),
        hex.substring(20, 32)
    ].join('-');
    return uuid;
}


function RecoveryConfigTask(req) {
    Task.call(this);
    this.req = req;
}

var logger = bunyan.createLogger({
    name: 'cn-agent',
    stream: process.stderr,
    level: 'debug',
    serializers: bunyan.stdSerializers
});


Task.createTask(RecoveryConfigTask);

function start() {
    var self = this;

    assert.object(self.sysinfo, 'self.sysinfo');
    assert.uuid(self.sysinfo.UUID, 'self.sysinfo.UUID');

    var kbmapiaddr;
    var server_uuid;
    var guid = self.req.params.pivtoken;
    var template = self.req.params.template;
    var action = self.req.params.action;
    var recovery_uuid = self.req.params.recovery_uuid;
    var token = self.req.params.token;
    var templateFile;
    var zpoolRecovery = {};
    var zpool;

    vasync.waterfall([
        function bailIfMissingPreconditions(cb) {
            if (!action || !guid || !recovery_uuid) {
                cb(Error('Missing required request parameters'));
                return;
            }

            if (['activate', 'stage'].indexOf(action) === -1) {
                cb(Error('Invalid value for action parameter'));
                return;
            }

            if (action === 'stage' && !template) {
                cb(Error('Missing template request parameter'));
                return;
            }
            cb();
        },

        function retrieveKbmapiAddresses(cb) {
            common.getSdcConfig(function (error, cfg) {
                if (error) {
                    cb(error);
                    return;
                }

                var domainName = 'kbmapi.' + cfg.datacenter_name + '.' +
                    cfg.dns_domain;

                logger.info({
                    domainName: domainName
                }, 'kbmapi domain name');

                dns.resolve(domainName, function (dnserror, addrs) {
                    if (dnserror) {
                        cb(dnserror);
                        return;
                    }

                    if (!addrs.length) {
                        cb('No KBMAPI addresses found');
                        return;
                    }

                    kbmapiaddr = addrs[0];
                    self.progress(10);
                    cb();
                });
            });
        },

        function getSysinfo(cb) {
            var obj = self.sysinfo;
            var zpoolEncryption = obj['Zpool Encrypted'];
            if (!zpoolEncryption) {
                cb(Error('Recovery configuration can be staged or ' +
                    'activated only on servers with encrypted zpools'));
                return;
            }
            zpoolRecovery = obj['Zpool Recovery'] || {};
            zpool = obj['Zpool'];
            server_uuid = obj.UUID;
            self.progress(25);
            cb();
        },

        function onlyStagedConfigCanBeActivated(cb) {
            if (action === 'activate' &&
                repeatableUUIDFromHexString(zpoolRecovery.staged) !==
                recovery_uuid) {
                cb(Error('Only the staged recovery configuration ' +
                    'can be activated'));
                return;
            }
            cb();
        },

        function saveTemplate(cb) {
            if (action === 'activate') {
                cb();
                return;
            }

            var fid = crypto.randomBytes(4).readUInt32LE(0);
            templateFile = '/var/tmp/.recovery-config-template-' + fid;
            // No need to write the file
            self.progress(50);
            cb();
        },

        function doAction(cb) {
            var cmd = '/usr/sbin/kbmadm';
            var args = ['recovery'];
            if (action === 'activate') {
                args.push('activate');
            } else {
                args.push('add', '-t', templateFile, '-r', token, zpool);
            }

            self.log.debug({cmdline: cmd + ' ' + args.join(' ')}, 'Executing');

            if (action === 'activate') {
                zpoolRecovery.active = zpoolRecovery.staged;
                delete zpoolRecovery.staged;
            } else {
                zpoolRecovery.staged = sha512str(template).toString('hex');
            }
            self.progress(65);
            cb();
        },

        function sysinfoUpdate(cb) {
            self.sysinfo['Zpool Recovery'] = zpoolRecovery;

            shared.writeSysinfo({
                log: self.log,
                serverRoot: common.SERVER_ROOT
            },
            self.sysinfo,
            function _onWroteSysinfo(err) {
                if (err) {
                    cb(err);
                    return;
                }

                self.progress(75);
                cb();
            });
        },
        /*
         * Sysinfo will be "automatically" updated into CNAPI at the given
         * period of time. We want KBMAPI updated too.
         */
        function postUpdatesToKbmapi(cb) {
            var url = 'http://' + kbmapiaddr;

            var restifyOptions = {
                url: url,
                connectTimeout: 5000,
                requestTimeout: 5000
            };

            logger.info('kbmapi ip was %s', kbmapiaddr);
            var client = restify.createJsonClient(restifyOptions);

            var params = {
                zpool_recovery: {},
                cn_uuid: server_uuid
            };
            Object.keys(zpoolRecovery).forEach(function uuidfromstr(k) {
                params.zpool_recovery[k] =
                    repeatableUUIDFromHexString(zpoolRecovery[k]);
            });

            if (token) {
                params.recovery_token =
                    repeatableUUIDFromHexString(sha512str(token));
            }

            var kbmapi_path = '/pivtokens/' + guid + '/recovery-tokens';
            client.put(kbmapi_path, params, function kbmapiCb(err) {
                self.progress(100);
                if (err) {
                    logger.warn({
                        error: err
                    }, 'posting info to kbmapi');
                } else {
                    logger.info('Posted zpool recovery info to kbmapi');
                }
                cb(err);
            });
        }
    ], function recoveryConfigTaskCb(err) {
        if (err) {
            self.fatal('Recovery Configuration error: ' + err.message);
            return;
        }

        self.finish();
    });
}

RecoveryConfigTask.setStart(start);

module.exports = RecoveryConfigTask;
