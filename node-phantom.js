//Released to the public domain.
var http = require('http')
,	fs = require('fs')
,	path = require('path')
,	socketio = require('socket.io')
,	child = require('child_process')
,	stub = fs.readFileSync(path.join(__dirname, "stub.html"))
,	debug = console.log;

var callbackOrDummy = function (callback) {
	if (callback === undefined) callback = function () {};
	return callback;
};

var unwrapArray = function (arr) {
	return arr && arr.length == 1 ? arr[0] : arr
};

module.exports = {
	create: function (callback, options) {
		if (options === undefined) options = {};
		if (options.phantomPath === undefined) options.phantomPath = 'phantomjs';
		if (options.parameters === undefined) options.parameters = {};

		var spawnPhantom = function (port, callback) {
			var hasErrors = false
			,	args = []
			,	phantom;

			for (var parm in options.parameters) {
				args.push('--' + parm + '=' + options.parameters[parm]);
			}
			args = args.concat([__dirname + '/bridge.js', port]);
			debug('spawn:', options.phantomPath, args)
			phantom = child.spawn(options.phantomPath, args);
			phantom.stdout.on('data', function (data) {
				return console.log('phantom stdout: ' + data);
			});
			phantom.stderr.on('data', function (data) {
				return console.warn('phantom stderr: ' + data);
			});
			phantom.on('error', function () {
				hasErrors = true;
			});
			phantom.on('exit', function (code) {
				hasErrors = true; //if phantom exits it is always an error
			});
			process.nextTick(function() {
				callback(hasErrors, phantom);
			});
			// setTimeout(function () { //wait a bit to see if the spawning of phantomjs immediately fails due to bad path or similar
			// 	callback(hasErrors, phantom);
			// }, 100);
		}

		var httpRequestListener = function (request, response) {
			response.writeHead(200, {
				"Content-Type": "text/html"
			});
			response.end(stub);
		};
		var server = http.createServer(httpRequestListener).listen(function () {
			var port = server.address().port
			,	io = socketio.listen(server, {
					'log level': 1
				});
			spawnPhantom(port, function (err, phantom) {
				if (err) {
					server.close();
					callback(true);
					return;
				}
				var pages = {}
				,	cmds = {}
				,	cmdid = 0;

				function request(socket, args, callback) {
					args.splice(1, 0, cmdid);
					//					console.log('requesting:'+args);
					socket.emit('cmd', JSON.stringify(args));

					cmds[cmdid] = {
						cb: callback
					};
					cmdid++;
				}

				io.sockets.on('connection', function (socket) {
					socket.on('res', function (response) {
						//						console.log(response);
						var id = response[0]
						,	cmdId = response[1];

						switch (response[2]) {
						case 'pageCreated':
							var pageProxy = {
								open: function (url, callback) {
									if (callback === undefined) {
										request(socket, [id, 'pageOpen', url]);
									} else {
										request(socket, [id, 'pageOpenWithCallback', url], callback);
									}
								}
								, close: function (callback) {
									request(socket, [id, 'pageClose'], callbackOrDummy(callback));
								}
								, render: function (filename, callback) {
									request(socket, [id, 'pageRender', filename], callbackOrDummy(callback));
								}
								, renderBase64: function (extension, callback) {
									request(socket, [id, 'pageRenderBase64', extension], callbackOrDummy(callback));
								}
								, injectJs: function (url, callback) {
									request(socket, [id, 'pageInjectJs', url], callbackOrDummy(callback));
								}
								, includeJs: function (url, callback) {
									request(socket, [id, 'pageIncludeJs', url], callbackOrDummy(callback));
								}
								, sendEvent: function (event, x, y, callback) {
									request(socket, [id, 'pageSendEvent', event, x, y], callbackOrDummy(callback));
								}
								, uploadFile: function (selector, filename, callback) {
									request(socket, [id, 'pageUploadFile', selector, filename], callbackOrDummy(callback));
								}
								, evaluate: function (evaluator, callback) {
									request(socket, [id, 'pageEvaluate', evaluator.toString()].concat(Array.prototype.slice.call(arguments, 2)), callbackOrDummy(callback));
								}
								, evaluateAsync: function (evaluator, callback) {
									request(socket, [id, 'pageEvaluateAsync', evaluator.toString()].concat(Array.prototype.slice.call(arguments, 2)), callbackOrDummy(callback));
								}
								, set: function (name, value, callback) {
									request(socket, [id, 'pageSet', name, value], callbackOrDummy(callback));
								}
								, get: function (name, callback) {
									request(socket, [id, 'pageGet', name], callbackOrDummy(callback));
								}
								, setFn: function (pageCallbackName, fn, callback) {
									request(socket, [id, 'pageSetFn', pageCallbackName, fn.toString()], callbackOrDummy(callback));
								}
								, setViewport: function (viewport, callback) {
									request(socket, [id, 'pageSetViewport', viewport.width, viewport.height], callbackOrDummy(callback));
								}
							}
							pages[id] = pageProxy;
							cmds[cmdId].cb(null, pageProxy);
							delete cmds[cmdId];
							break;
						case 'phantomExited':
							request(socket, [0, 'exitAck']);
							server.close();
							io.set('client store expiration', 0);
							cmds[cmdId].cb();
							delete cmds[cmdId];
							break;
						case 'pageJsInjected':
						case 'jsInjected':
							cmds[cmdId].cb(JSON.parse(response[3]) === true ? null : true);
							delete cmds[cmdId];
							break;
						case 'pageOpened':
							if (cmds[cmdId] !== undefined) { //if page is redirected, the pageopen event is called again - we do not want that currently.
								if (cmds[cmdId].cb !== undefined) {
									cmds[cmdId].cb(null, response[3]);
								}
								delete cmds[cmdId];
							}
							break;
						case 'pageRenderBase64Done':
							cmds[cmdId].cb(null, response[3]);
							delete cmds[cmdId];
							break;
						case 'pageGetDone':
						case 'pageEvaluated':
							cmds[cmdId].cb(null, JSON.parse(response[3]));
							delete cmds[cmdId];
							break;
						case 'pageClosed':
							delete pages[id]; // fallthru
						case 'pageSetDone':
						case 'pageJsIncluded':
						case 'cookieAdded':
						case 'pageRendered':
						case 'pageEventSent':
						case 'pageFileUploaded':
						case 'pageSetViewportDone':
						case 'pageEvaluatedAsync':
							cmds[cmdId].cb(null);
							delete cmds[cmdId];
							break;
						default:
							console.error('got unrecognized response:' + response);
							break;
						}
					});
					socket.on('push', function (request) {
						var id = request[0];
						var cmd = request[1];
						var callback = callbackOrDummy(pages[id] ? pages[id][cmd] : undefined);
						callback(unwrapArray(request[2]));
					});
					var proxy = {
						createPage: function (callback) {
							request(socket, [0, 'createPage'], callbackOrDummy(callback));
						}
						, injectJs: function (filename, callback) {
							request(socket, [0, 'injectJs', filename], callbackOrDummy(callback));
						}
						, addCookie: function (cookie, callback) {
							request(socket, [0, 'addCookie', cookie], callbackOrDummy(callback));
						}
						, exit: function (callback) {
							phantom.removeListener('exit', prematureExitHandler); //an exit is no longer premature now
							request(socket, [0, 'exit'], callbackOrDummy(callback));
						}
						, on: function () {
							phantom.on.apply(phantom, arguments);
						}
						, _phantom: phantom
					};

					callback(null, proxy);
				});

				// An exit event listener that is registered AFTER the phantomjs process
				// is successfully created.
				var prematureExitHandler = function (code, signal) {
					console.warn('phantom crash: code ' + code);
					server.close();
				};

				phantom.on('exit', prematureExitHandler);
			});
		});
	}
};