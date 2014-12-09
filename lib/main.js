"use strict";

var exports = module.exports = {};

var extend = require('extend'),
    aws = require('aws-sdk'),
    md5 = require('MD5'),
    Q = require('q'),
    rx = require('rx'),
    fs = require('fs');

var versions = {
    sqs: "2014-11-11",
    lambda: "2014-11-11"
};

var settings = {
    accessKey: '',
    secretKey: '',
    region: 'us-west-2',
    uploadTimeout: 5000
};

var defaultFunctionSettings = {
    memory: 128, // mb
    description: '',
    timeout: 3  // seconds
};

aws.config.apiVersions = versions;

var sqs,
    lambda;

var sqsMessages = new rx.Subject(),
    sqsQueueUrl = '';

var _initialized = false,
    _initializedDeferred = Q.defer();

var _lambdaize = function (func) {
    // http://docs.aws.amazon.com/lambda/latest/dg/lambda-introduction.html#programming-model

    var _lambda = function(event, context) {

        var executionSucceeded = true,
            executionError = null;

        // TODO (Next iteration) Move requires elsewhere
        var AWS_sdk = require('aws-sdk'),
            sqs_svc = new AWS_sdk.SQS();

        var _sendToSqs = function(data, afterSentCallback) {
            // TODO (Next iteration) Check MessageBody length and upload to S3 if too lengthy
            var params = {
                MessageBody: JSON.stringify(data),
                QueueUrl: event.sqsQueueUrl
            };
            sqs_svc.sendMessage(params, function(err) {
                if(err) console.log('Error sending response to sqs'); 
                afterSentCallback();
            });
        };

        var _newCallback = function (err) {
            var finishExecution = function() { /*context.done()*/ };
            if(typeof(err) !== 'undefined' && err.isFaulty) {
                _sendToSqs({success: false, data: err}, finishExecution);
            } 
            else {
                _sendToSqs({success: true, data: arguments}, finishExecution);
            }
        };

        var userFunc = /*<func>*/null;

        event.args.push(_newCallback);

        try {
            userFunc.apply(this, event.args);
        }
        catch(error) {
            _newCallback({isFaulty: true, stack: error.stack, message: error.message});
        }
    };

    return (_lambda.toString().replace('/*<func>*/null', func.toString());
};

var _uploadFunctionAsync = function (lambdaFunc, config) {
    var deferred = Q.defer();

    var handlerName = config.name || 'default';
    var functionAsString = 'exports.' + handlerName + '=' + lambdaFunc + ';';
    var functionMD5 = md5(functionAsString);
    // TODO : add configs in hash

    var params = {
        FunctionName: handlerName.concat('_', functionMD5), // TODO Find a better way to name functions?
        FunctionZip: functionAsString, // TODO Zip function
        Handler: handlerName,
        Mode: 'event', // Even though we invoke manually

        // TODO The Amazon Resource Name (ARN) of the IAM role that Lambda assumes when it executes your function to access any other Amazon Web Services (AWS) resources.
        Role: 'STRING_VALUE',

        Runtime: 'nodejs',
        Description: config.description,
        MemorySize: config.memory,
        Timeout: config.timeout
    };

    // TODO Check if the function is already on Lambda and overwrite it
    // lambda.uploadFunction(params, function (err, data) {
    //     if (err) {
    //         deferred.reject(err);
    //     } else {
    //         deferred.resolve(data);
    //     }
    // });

    return deferred.promise.timeout(settings.uploadTimeout, "Function upload to AWS Lambda timed out.");
};

var _startListeningToSQS = function(sqsQueueUrl, rxQueue) {
    
    var recursiveSQSCall = function() {
        var params = {
          QueueUrl: sqsQueueUrl,
          MaxNumberOfMessages: 10
        };

        sqs.receiveMessage(params, function(err, data) {
            for(var i in data.Messages) {
                rxQueue.onNext(data.Messages[i]);
            }
            recursiveSQSCall(); // <-- Recurse point
        });
    };

    recursiveSQSCall();
};

var _startPickingUpSQSMessages = function(sqsQueueUrl, rxQueue) {

    rxQueue
    .distinct(function(x) {
        return x.MessageId;
    })
    .subscribe(function(x) {

        var body = JSON.parse(x.Body);
        console.log("SQS <- ", body);
        // TODO Execute Callback with args
        // TODO (version 2) Get result from S3 if length > 256kb
        // TODO If callback wasn't handled, exit early
        sqs.deleteMessage({
            QueueUrl: sqsQueueUrl,
            ReceiptHandle: x.ReceiptHandle
        }, function(err, data) {
            if(err) console.log("SQS Deletion failed", x.MessageId); // TODO Handle error gracefully
        });
    });

};

// Public API

exports.config = function (params) {
    extend(settings, params);

    aws.config.update({
        accessKeyId: settings.accessKey,
        secretAccessKey: settings.secretKey,
        region: settings.region
    });

    sqs = new aws.SQS();
    lambda = new aws.Lambda();
};

exports.start = function(startedCallback) {

    if(_initialized) throw "Already initialized";

    var params = {
      QueueName: 'LambdaResultsQueue', // TODO Ability to change the queue name
      Attributes: {
        MaximumMessageSize: '262144',
        ReceiveMessageWaitTimeSeconds: '20',
      }
    };

    sqs.createQueue(params, function(err, data) {
        if (err) { startedCallback(err); return; }

        sqsQueueUrl = data.QueueUrl;
        _startListeningToSQS(sqsQueueUrl, sqsMessages);
        _startPickingUpSQSMessages(sqsQueueUrl, sqsMessages);
        _initialized = true;
        _initializedDeferred.resolve(sqsQueueUrl);

        if(typeof(startedCallback) === 'function') startedCallback();
    });
};

exports.create = function(func, config) {
    var functionConfig = extend(true, {}, defaultFunctionSettings, config);

    var lambda = _lambdaize(func);

    var uploadPromise = _uploadFunctionAsync(lambda, functionConfig);

    var proxy = function () {

        var args = Array.prototype.slice.call(arguments);
        if(typeof(args[args.length -1]) !== 'function') {
            throw "Expected last argument to be a callback";
        }

        var callb = args.pop();
        
        Q.all([_initializedDeferred.promise, uploadPromise]).spread(function(uploadData) {
            console.log(uploadData);
            var params = {
              FunctionName: uploadData.FunctionData,
              InvokeArgs: {
                args: args,
                sqsQueueUrl: queueUrl
              }
            };

            // lambda.invokeAsync(params, function(err, data) {
            //   if (err) console.log(err, err.stack); // TODO Handle Error gracefully
            //   else {
            //     // TODO Register the RequestId to the original callback
            //     console.log("Lambda response", data);
            //   }
            // });

        });

        uploadPromise.catch(function() {
            throw "Could not uplaod function to Amazon S3";
        });

    };

    return proxy;
};