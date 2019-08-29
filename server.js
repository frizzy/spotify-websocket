import fs from 'fs'
import YAML from 'yaml';
import http from 'http';
import polka from 'polka';
import WebSocket from 'ws';
import nunjucks from 'nunjucks';
import spotifyWebApi from './spotify-web-api';
import cors from 'cors';
import compress from 'compression';
import storage from 'node-persist';

const templating = new nunjucks.Environment(new nunjucks.FileSystemLoader('views'));
const render = (res) => (err, out) => {
  if (err) {
    console.error(err);
    res.writeHead(500);
    return res.end();
  }
  res.end(out);
};

const log = (...messages) => console.log(new Date().toISOString(), ...messages);

const { PORT = 3000 } = process.env;

let config;
const configs = [ 'client_id', 'client_secret', 'scope', 'redirect_uri' ];

try {
  const file = fs.readFileSync('./config.yaml', 'utf8');
  config = YAML.parse(file);
} catch (err) {
  config = {};
}
for (const name of configs) {
  if (name.toUpperCase() in process.env) {
    config[name] = process.env[name.toUpperCase()];
    if (name === 'scope') {
      config[name] = YAML.parse(`[${String(config[name]).replace(/^\[|\]$/g, '')}]`);
    }
  } else if (!(name in config)) {
    throw new Error(`Config option "${name}" or environment variable "${name.toUpperCase()}" not defined specified.`);
  }
}
for (const name of [ 'persist' ]) {
  if (name.toUpperCase() in process.env) {
    config[name] = process.env[name.toUpperCase()];
  }
}

let { persist, ...rest } = config;
config = rest;

const spotify = spotifyWebApi(config);

const sessions = {};
const deleteSession = (id) => {
  persist && storage.removeItem(id);
  delete sessions[id];
};

const app = polka();
const server = http.createServer(app.handler);
const wss = new WebSocket.Server({ server });

let clients = [];

const send = (message, client = null) => {
  message = JSON.stringify(message);
  if (client && client.readyState === WebSocket.OPEN) {
    client.send(message);
  } else {
    clients.filter(client => client.readyState === WebSocket.OPEN).forEach(client => client.send(message));
  }
};

const updateClients = () => {
  clients = [ ...wss.clients ].filter(client => client.readyState === WebSocket.OPEN);
};

let delay = 1000;
let tries = 0;
const interval = setInterval(() => {
  if (!clients.length) {
    return;
  }
  Object.entries(sessions).forEach(async ([ id, session ]) => {
    delay = 1000;
    try {
      let { body, ...rest } = await spotify.api(session).player.playing();
      tries > 0 && log({ 'ok': true });
      tries = 0;
      send({ id, ...body });
    } catch (err) {
      if (err.code === 429) {
        console.log(err.message);
        delay = err.value * 1000;
      } else {
        if (tries > 5) {
          console.error(new Date().toISOString(), { id }, err);
          delay = 60000;
          return;
        }
        log({ id }, err);
        delay = 2000;
        tries += 1;
      }
    }
  });
}, delay);

wss.on('connection', async ws => {

  updateClients();
  log({ event: 'client_connected' });
  ws.on('message', data => {
    data = JSON.parse(data);
    const { id, name, query, body, request_id } = data;
    if (id && id in sessions) {
      const parts = name.split('.');
      if (parts[0] === 'player') {
        log('Player');
        spotify.api(sessions[id]).player[parts[1]]({ query, body })
        .then(({ res, body, ...rest }) => {
          send({ id, request_id, request: parts[1], ...body, ...rest }, ws);
        })
        .catch(err => console.error(new Date().toISOString(), { event: `player.${parts[1]}` }, err));
      }
    }
    log({ event: 'message' }, data);
  });
});

(async function () {
  let states = [];

  const login = (req, res) => {
    log({ http: '/login' });
    let { header, state } = spotify.init();
    states.push(state);
    res.writeHead(303, header);
    send({ event: 'init_authentication' });
    res.end();
  };

  const refresh = (id) => {
    log({ id, event: 'refresh_trigger', in: sessions[id].expires_in });
    sessions[id].timeout = setTimeout(() => {
      spotify.auth.refresh(sessions[id].refresh_token).then(async ({ access_token, expires_in }) => {
        send({ id, event: 'token_refresh'});
        sessions[id] = {
          ...sessions[id],
          access_token,
          expires_in,
          timestamp: new Date().toISOString()
        };
        persist && await storage.setItem(id, sessions[id]);
        refresh(id);
      }).catch(err => {
        deleteSession(id);
        console.error(new Date().toISOString(), err);
      });
    }, (sessions[id].expires_in - 360) * 1000);
  }

  if (persist) {
    await storage.init({ dir: persist });
    storage.forEach(async function({ key, value }) {
      log({ id: key, event: 'persistence loaded' });
      sessions[key] = {
        ...value,
        expires_in: 0
      };
      refresh(key);
    });
  }

  const redirect = ({ query: { code, state } = {}, ...req }, res) => {
    log({ http: '/redirect' });
    if (! states.includes(state)) {
      console.error(new Date().toISOString(), 'Auth state not matched.');
      res.writeHead(403);
      return res.end('Forbidden');
    }
    states = states.filter(item => item !== state);
    spotify.auth.token(code)
    .then(auth => {
      spotify.api(auth).user()
      .then(async ({ body: { display_name, uri: id } }) => {
        sessions[id] = { ...auth, timestamp: new Date().toISOString() };
        await storage.setItem(id, sessions[id]);
        send({ id, event: 'authenticated' });
        refresh(id);
        res.writeHead(303, { Location: `/?b=${Date.now()}` });
        res.end();
      }).catch(err => console.error(new Date().toISOString(), { event: 'user_profile' }, err));
    }).catch(err => {
      console.error(new Date().toISOString(), { event: 'auth_token' }, err);
      res.writeHead(403);
      return res.end(err.message);
    });
  };

  app
    .use(cors({ origin: true }))
    .get('/', async (req, res) => {
      log({ http: '/' });
      const promises = [];
      const results = await Promise.all(
        Object.keys(sessions).map(id => {
          return { id, promise: spotify.api(sessions[id]).user() };
        }).map(({ id, promise }) => promise.catch(e => {
          console.error(e);
          deleteSession(id);
          return e;
        }))
      );
      let values = results.filter(result => !(result instanceof Error));
      values = values.map(({ body }) => body);
      templating.render('index.html', { users: values }, render(res));
    })
    .get('/login', login)
    .get('/redirect', redirect);
})();

server.listen(PORT, err => {
  log({ event: 'listening 1', port: PORT });
});
