/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var util = require('util');
var format = util.format;
var path = require('path');
var jsprim = require('jsprim');
var common = require('./common');
var TaskRunner = require('./task_runner');
var bunyan = require('bunyan');
var restify = require('restify');
var os = require('os');
var async = require('async');
var EventEmitter = require('events').EventEmitter;
var assert = require('assert-plus');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function TaskAgent(opts) {
    EventEmitter.call(this);
    assert.object(opts.agentserver, 'opts.agentserver');
    assert.object(opts.backend, 'opts.backend');
    assert.optionalObject(opts.env, 'opts.env');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.tasklogdir, 'opts.tasklogdir');
    assert.string(opts.taskspath, 'opts.taskspath');
    assert.object(opts.sysinfo, 'opts.sysinfo');
    assert.number(opts.timeoutSeconds, 'opts.timeoutSeconds');
    assert.string(opts.uuid, 'opts.uuid');

    this.sysinfo = opts.sysinfo;
    this.tasklogdir = opts.tasklogdir;
    this.taskspath = opts.taskspath;

    this.log = bunyan.createLogger({ name: opts.logname });
    opts.log = this.log;

    this.agentserver = opts.agentserver;
    this.env = opts.env || {};

    if (opts.taskspath) {
        this.taskspath = opts.taskspath;
    } else {
        this.log.warn(
            'Warning: no taskPaths specified when instantiating TaskAgent');
        this.taskspath = path.join(__dirname, '..', 'tasks');
    }
    this.uuid = opts.uuid;
    this.timeoutSeconds = opts.timeoutSeconds;

    this.runner = new TaskRunner({
        backend: opts.backend,
        env: this.env,
        log: this.log,
        logdir: this.tasklogdir,
        taskspath: this.taskspath,
        timeoutSeconds: this.timeoutSeconds
    });
}

util.inherits(TaskAgent, EventEmitter);

TaskAgent.prototype.start = function () {
    var self = this;
    self.setupTaskRoutes(self.queueDefns);
    self.setupTaskHistory();
};


TaskAgent.prototype.setupTaskRoutes = function (defns) {
    var self = this;

    self.log.info('Setting up task route for %s', self.uuid);
    this.agentserver.registerTaskHandler(self.uuid, handler);

    function handler(req, res, next) {
        var target = req.header('x-server-uuid');

        // Ensure this request was intended for our server uuid
        if (target !== undefined && target !== self.uuid) {
            next(new restify.InternalError('received request for wrong server' +
                '. we are: "' + self.uuid + '" received: "' + target + '"'));
            return;
        }

        if (!req.params.hasOwnProperty('task')) {
            next(new restify.InvalidArgumentError(
                'Missing key \'task\''));
            return;
        }

        if (!req.params.hasOwnProperty('params')) {
            next(new restify.InvalidArgumentError(
                'Missing key \'params\''));
            return;
        }

        var dispatch = {};
        var taskName = req.params.task;
        var logParams = true;

        // Setup req/res connection timeouts, to be 5 minutes longer than the
        // task timeout, as that will give the task runner up to 5 minutes to
        // properly kill and cleanup the task if it timed out.
        req.connection.setTimeout((self.timeoutSeconds + 300) * 1000);
        res.connection.setTimeout((self.timeoutSeconds + 300) * 1000);

        self.queueDefns.forEach(function (i) {
            i.tasks.forEach(function (j) {
                if (j === taskName && i.log_params === false) {
                    logParams = false;
                }

                dispatch[j] = i.onhttpmsg;
            });
        });

        if (logParams) {
            req.log.info({ task: req.params }, '%s task params', taskName);
        } else {
            req.log.info(
                'Not logging task params for %s (log_params=false)', taskName);
        }

        var value, error;

        var cbcount = 0;
        function fcb() {
            cbcount++;

            if (cbcount === 2) {
                if (error) {
                    res.send(500, error);
                    next();
                    return;
                }
                res.send(200, value);
                next();
            }
        }

        // All this data will end up being passed as req to the tasks' start().
        var params = {
            req_id: req.getId(),
            req_host: req.headers.host,
            serverAddress: self.agentserver.server.address(),
            task: req.params.task,
            params: req.params.params,
            sysinfo: self.sysinfo,
            finish: function () {
                fcb();
            },
            progress: function (v) {
            },
            event: function (name, message) {
                self.log.trace(
                    { name: name, message: message }, 'Received event');
                if (name === 'finish') {
                    value = message;
                    fcb();
                } else if (name === 'error') {
                    error = message;
                }
            }
        };

        // NEED TO CALL DISPATCH FN WITH A "REQ" OBJECT
        var taskfn = dispatch[req.params.task];
        if (taskfn) {
            dispatch[req.params.task](params);
        } else {
            next(new restify.ResourceNotFoundError(
                'Unknown task, \'%s\'', req.params.task));
        }
    }
};


TaskAgent.prototype.useQueues = function (defns) {
    var self = this;
    self.queueDefns = defns;
};


TaskAgent.prototype.setupTaskHistory = function () {
    var self = this;
    self.agentserver.setTaskHistory(self.runner.taskHistory);
};


module.exports = TaskAgent;
