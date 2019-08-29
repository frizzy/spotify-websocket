FROM node:10-alpine

WORKDIR /

RUN mkdir /spotify-websocket

COPY views/ /spotify-websocket/views
COPY *.js /spotify-websocket/
COPY package*.json /spotify-websocket/

WORKDIR /spotify-websocket

RUN npm install

ENTRYPOINT [ "npm", "start" ]
