/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var fs = require('fs');
var execFile = require('child_process').execFile;
var netconfig = require('triton-netconfig');
var VError = require('verror').VError;


function agentConfig(callback) {
    var config;
    var agentConfigPath = '/opt/smartdc/agents/etc/cn-agent.config.json';
    var err = null;

    try {
        config = JSON.parse(fs.readFileSync(agentConfigPath, 'utf-8'));
    } catch (e) {
        err = new VError(e, 'Could not parse agent config');
    }

    callback(err, config);
}


function execFileParseJSON(bin, args, callback) {
    execFile(bin, args, function (error, stdout, stderr) {
        if (error) {
            callback(Error(stderr.toString()));
            return;
        }
        var obj = JSON.parse(stdout.toString());
        callback(null, obj);
    });
}

function sysinfo(callback) {
    execFileParseJSON('/usr/bin/sysinfo', [], function (error, config) {
        if (error) {
            callback(error);
            return;
        }
        callback(null, config);
    });
}

function sdcConfig(callback) {
    var args = ['/lib/sdc/config.sh', '-json'];

    execFileParseJSON('/bin/bash', args, function (error, config) {
        if (error) {
            callback(error);
            return;
        }
        callback(null, config);
    });
}

function _getAdminIpSysinfo(sysinfo_object, callback) {
    var adminIp = netconfig.adminIpFromSysinfo(sysinfo_object);

    if (!adminIp) {
        callback(new VError('Could not find admin IP'));
        return;
    }

    callback(null, adminIp);
}

/*
 * Also, allow callers to pass in their own sysinfo object.
 */
function getFirstAdminIp(sysinfo_object, callback) {
    if (!callback) {
        callback = sysinfo_object;
        sysinfo(function (err, sysinfoObj) {
            if (err) {
                callback(err);
                return;
            }

            _getAdminIpSysinfo(sysinfoObj, callback);
        });
        return;
    }
    _getAdminIpSysinfo(sysinfo_object, callback);
}

module.exports = {
    getFirstAdminIp: getFirstAdminIp,
    sdcConfig: sdcConfig,
    agentConfig: agentConfig,
    sysinfo: sysinfo
};
