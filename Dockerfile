# better-sqlite3 is a native module: it is compiled here, in a stage built
# from the same image the app runs on, and copied as built. A module compiled
# against another libc fails at require time, not at build time, which is the
# worst moment to find out.
FROM node:lts-slim AS build
WORKDIR /app

# node-gyp's toolchain, when no prebuilt binary matches. The runtime stage
# never needs it, which is the point of building here.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
# A second lockfile install rather than `npm prune`: prune re-resolves the
# tree and stops on a devDependency peer range, which is a thing to fix in
# its own commit, not inside an image build. This runs here, with the
# toolchain, so better-sqlite3 is compiled once more and the runtime stage
# still gets a module built against its own libc.
RUN npm ci --omit=dev

FROM node:lts-slim
WORKDIR /app
ENV NODE_ENV=production
# One volume holds every piece of state: the database file and the uploaded
# attachment bytes both live under /app/data.
ENV SQLITE_FILE=/app/data/data.db
ENV ATTACHMENTS_DIR=/app/data/attachments

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json /app/next.config.ts ./
# The CLI is part of the product, not a dev convenience: creating the first
# account and running a TestRail import are node scripts over lib/, so the
# source they import ships in the image.
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts

# The mount point has to be writable by the user the server runs as, and a
# volume inherits the ownership of the directory it covers.
RUN install -d -o node -g node /app/data
USER node

EXPOSE 3000
CMD ["./node_modules/.bin/next", "start"]
