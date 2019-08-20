var https = require('https');
var Error = require('http-errors');
var Crypto = require('crypto');

var cache = {};

var CACHE_KEY = {
  API_URL: 'API_URL'
};

function aes_encrypt(buf, secret) {
  var c = Crypto.createCipher('aes192', secret);
  var b1 = c.update(buf);
  var b2 = c.final();
  return Buffer.concat([ b1, b2 ]);
}

function authenticate(config, stuff, user, accessToken, cb) {
  var cacheTTLms = config['cache-ttl-ms'] || 1000 * 30;
  var apiUrl = cache[CACHE_KEY.API_URL] || 'api.github.com';
  var apiPath = cache[apiUrl] ? '/api/v3/user/orgs' : '/user/orgs';

  if (cache[user] && cache[user].token === accessToken) {
    if (cache[user].expires > Date.now()) {
      // cache hit
      cache[user].expires = Date.now() + cacheTTLms;
      return cb(null, cache[user].orgs);
    }
  }

  var opts = {
    host: apiUrl,
    port: 443,
    path: apiPath,
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': stuff.config.user_agent,
      'Authorization': 'Bearer ' + accessToken
    }
  };

  https.request(opts, function(resp) {
    var body = [];

    resp.on('error', function() {
      return cb(Error[502]('unexpected error'));
    });

    resp.on('data', function(chunk) {
      body.push(chunk);
    });

    resp.on('end', function() {
      var data = Buffer.concat(body).toString();

      if (resp.statusCode !== 200) {
        return cb(Error[resp.statusCode]('unexpected response from github: "' + data + '"'));
      }

      var orgs = JSON.parse(data).map(function(org) {
        return org.login;
      });

      if (orgs.indexOf(config.org) === -1) {
        return cb(Error[403]('user "' + user + '" is not a member of "' + config.org + '"'));
      }

      cache[user] = {
          token: accessToken,
          orgs: orgs,
          expires: Date.now() + cacheTTLms
      }
      return cb(null, orgs);
    });
  }).end();
}

function middlewares(config, stuff, app, auth, storage) {
  var clientId = config['client-id'];
  var clientSecret = config['client-secret'];
  var gitHostname = config['git-hostname'] || 'github.com';
  var apiUrl = config['git-hostname'] ? config['git-hostname'] : 'api.github.com';
  var apiPath = config['git-hostname'] ? '/api/v3/user' : '/user';
  cache[CACHE_KEY.API_URL] = apiUrl;
  if (clientId === undefined || clientSecret === undefined) {
    throw Error('server needs to be configured with github client id and secret')
  }

  app.use('/oauth/authorize', function(req, res) {
    res.redirect('https://' + gitHostname + '/login/oauth/authorize?client_id=' + clientId + '&scope=read:org')
  });

  app.use('/-/oauth/callback', function(req, res, next) {
    var code = req.query.code;

    var data = JSON.stringify({
      'code': code,
      'client_id': clientId,
      'client_secret': clientSecret
    });

    var opts = {
      host: gitHostname,
      port: 443,
      path: '/login/oauth/access_token',
      method: 'POST',
      headers: {
        'User-Agent': stuff.config.user_agent,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Accept': 'application/json'
      }
    };

    var r = https.request(opts, function(resp) {
      var body = [];
      resp.on('error', function() {
        return next(Error[502]('unexpected error'))
      });
      resp.on('data', function(chunk) {
        body.push(chunk);
      });
      resp.on('end', function() {
        var data = Buffer.concat(body).toString();

        if (resp.statusCode !== 200) {
          return next(Error[resp.statusCode]('unexpected response from github: "' + data + '"'));
        }

        var accessToken = JSON.parse(data).access_token;
        var opts = {
          host: apiUrl,
          port: 443,
          path: apiPath,
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': stuff.config.user_agent,
            'Authorization': 'Bearer ' + accessToken
          }
        };

        https.request(opts, function(resp) {
          var body = [];
          resp.on('data', function(chunk) {
            body.push(chunk);
          }).on('end', function() {
            var data = Buffer.concat(body).toString();

            if (resp.statusCode !== 200) {
              return next(Error[resp.statusCode]('unexpected response from github: "' + data + '"'));
            }

            var user = JSON.parse(data).login;
            if (user === undefined) {
              return next(Error[502]('error getting user from github: ' + data))
            }

            var token = aes_encrypt(user + ':' + accessToken, auth.secret).toString('base64');
            res.redirect('http://localhost:8239?token=' + encodeURIComponent(token));
          });
        }).end();
      });
    });

    r.write(data);
    r.end();
  });
}

module.exports = function(config, stuff) {
  return {
    authenticate: authenticate.bind(undefined, config, stuff),
    register_middlewares: middlewares.bind(undefined, config, stuff)
  }
};

