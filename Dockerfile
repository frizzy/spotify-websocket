FROM node:10-alpine

WORKDIR /

RUN mkdir /spotify-websocket
WORKDIR /spotify-websocket
COPY package*.json /spotify-websocket/
RUN npm install

COPY views/ /spotify-websocket/views
COPY *.js /spotify-websocket/

ENTRYPOINT [ "npm", "start" ]
