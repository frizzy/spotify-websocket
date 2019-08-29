import fetch from 'node-fetch';
import uuid4 from 'uuid/v4';


class ClientError extends Error {
  constructor(name, code, value = null) {
    super(`${name} (${code})`);
    Error.captureStackTrace(this, ClientError);
    this.name = name;
    this.code = code;
    this.value = value;
  }
}

const queryStringify = query => Object.entries(query).map(pair => pair.join('=')).join('&');

const responseError = res => {
  if (res.status > 299) {
      throw new ClientError(...[
        res.statusText,
        res.status,
        ...(
          res.status === 429 ? [ parseInt(res.headers.get('Retry-After')) ] : []
        )
      ]);
  }
  return res;
};

const handleResponse = async res => {
  if (res.status === 204) {
    return { body: {}, no_content: true, res };
  }
  if (res.status === 202) {
    return { body: {}, accepted: true, res };
  }
  try {
    let body = await res.json();
    return { body, res } ;
  } catch (err) {
    console.error(err);
    return { body: {}, error: err.message, res };
  }
};

const api = ({
  client_id,
  client_secret,
  redirect_uri,
  scope = []
}) => {

  const endpoint = 'https://api.spotify.com/v1';

  const request = new Proxy({}, {
    get: (obj, prop) => ({ body, path, query }, { access_token, access_type = 'Bearer'}) => {
      let url = `${endpoint}/${path}`;
      if (query) {
        url = `${url}?${queryStringify(query)}`;
      }
      //console.log(prop.toUpperCase(), url);
      return fetch(url, {
        method: prop.toUpperCase(),
        headers: {
          Authorization: `${access_type} ${access_token}`
        },
        ...(body && { body: JSON.stringify(body) })
      })
      .then(responseError)
      .then(handleResponse);
    }
  });

  const token = ({ code, refresh_token, redirect_uri, grant_type = 'authorization_code' }) => {

    return fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: queryStringify({
        grant_type,
        ...(grant_type === 'authorization_code' ? { code, redirect_uri } : { refresh_token } )
      })
    })
    .then(responseError)
    .then(res => res.json())
  };

  return {

    init: ({ state } = {}) => {
      state = state || uuid4();
      const location = `https://accounts.spotify.com/authorize?${queryStringify({
        response_type: 'code',
        client_id,
        scope: scope.join(' '),
        redirect_uri,
        state
      })}`;

      return {
        uri: location,
        header: { Location: location },
        state
      }
    },
    auth: {
      token: (code) => token({ code, redirect_uri }),
      refresh: (refresh_token) => token({ grant_type: 'refresh_token', refresh_token })
    },
    api: (auth) => ({
      user: (user = null) => request.get({
        path: user ? `users/${user}` : 'me'
      }, auth),
      player: {
        play: ({ query, body } = {}) => request.put({ path: 'me/player/play', query, body }, auth),
        pause: ({ query } = {}) => request.put({ path: 'me/player/pause', query, body: {} }, auth),
        previous: ({ query } = {}) => request.post({ path: 'me/player/previous', query }, auth),
        next: ({ query } = {}) => request.post({ path: 'me/player/next', query }, auth),
        recent: ({ query } = {}) => request.get({ path: 'me/player/recently-played', query }, auth),
        playing: ({ query } = {}) => request.get({ path: 'me/player/currently-playing', query }, auth),
        player: ({ query } = {}) => request.get({ path: 'me/player', query }, auth),
        shuffle: ({ query } = {}) => request.put({ path: 'me/player/shuffle', query, body: {} }, auth),
        repeat: ({ query } = {}) => request.put({ path: 'me/player/repeat', query, body: {} }, auth),
        volume: ({ query } = {}) => request.put({ path: 'me/player/volume', query, body: {} }, auth),
        seek: ({ query } = {}) => request.put({ path: 'me/player/seek', query, body: {} }, auth),
        transfer: ({ query } = {}) => request.put({ path: 'me/player', query, body: {} }, auth),
        devices: () => request.get({ path: 'me/player/devices' }, auth),
      }
    })
  }

};

export default api;
