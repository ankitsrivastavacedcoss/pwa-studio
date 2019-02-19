const debug = require('../util/debug').makeFileLogger(__filename);
const debugErrorMiddleware = require('debug-error-middleware').express;
const {
    default: playgroundMiddleware
} = require('graphql-playground-middleware-express');
const url = require('url');
const optionsValidator = require('../util/options-validator');
const configureHost = require('../Utilities/configureHost');
const portscanner = require('portscanner');
const { readdir: readdirAsync, readFile: readFileAsync } = require('fs');
const { promisify } = require('util');
const readdir = promisify(readdirAsync);
const readFile = promisify(readFileAsync);
const { resolve, relative } = require('path');
const addImgOptMiddleware = require('../Utilities/addImgOptMiddleware');
const { highlight, logger } = require('../Utilities/logging');
const log = logger();

const secureHostWarning = `To enable all PWA features and avoid ServiceWorker collisions, PWA Studio highly recommends using the ${highlight(
    '"provideSecureHost"'
)} configuration option of PWADevServer. `;

const helpText = `To autogenerate a unique host based on project name and location on disk, simply add: ${highlight(
    'provideSecureHost: true'
)} to PWADevServer configuration options.

More options for this feature are described in documentation.
`;

const PWADevServer = {
    validateConfig: optionsValidator('PWADevServer', {
        publicPath: 'string',
        env: 'object'
    }),
    async configure(config) {
        debug('configure() invoked', config);
        PWADevServer.validateConfig('.configure(config)', config);
        const devServerConfig = {
            contentBase: false, // UpwardPlugin serves static files
            compress: true,
            hot: true,
            host: '0.0.0.0',
            port: await portscanner.findAPortNotInUse(10000),
            stats: {
                all: !process.env.NODE_DEBUG ? false : undefined,
                builtAt: true,
                colors: true,
                errors: true,
                errorDetails: true,
                moduleTrace: true,
                timings: true,
                version: true,
                warnings: true
            },
            after(app, server) {
                app.use(debugErrorMiddleware());
                const origin = devServerConfig.publicPath;
                server.middleware.waitUntilValid(() => {
                    log.ready(`PWADevServer running at ${highlight(origin)}`);
                    if (config.graphqlPlayground) {
                        log.bonus(
                            `GraphQL playground running at ${highlight(
                                new url.URL('/graphiql', origin).href
                            )}`
                        );
                    }
                });
            },
            before(app) {
                addImgOptMiddleware(app, config.env);
            }
        };
        const { id, provideSecureHost } = config;
        if (id || provideSecureHost) {
            const hostConf = {};
            // backwards compatibility
            if (id) {
                const desiredDomain = id + '.' + configureHost.DEV_DOMAIN;
                log.warn(
                    `The 'id' configuration option is deprecated and will be removed in upcoming releases. It has been replaced by 'provideSecureHost' configuration which can be configured to have the same effect as 'id'.`
                );
                log.info(`To create the subdomain ${desiredDomain}, use:
    ${highlight(
        `provideSecureHost: { subdomain: "${id}", addUniqueHash: false }`
    )}
 To omit the default ${
     configureHost.DEV_DOMAIN
 } and specify a full alternate domain, use: ${highlight(
                    `provideSecureHost: { exactDomain: "${id}.example.dev" }`
                )} (or any other top-level domain).

 ${helpText}`);

                hostConf.addUniqueHash = false;
                hostConf.subdomain = id;
            } else if (provideSecureHost === true) {
                hostConf.addUniqueHash = true;
            } else if (typeof provideSecureHost === 'object') {
                Object.assign(hostConf, provideSecureHost);
            } else {
                throw new Error(
                    debug.errorMsg(
                        `Unrecognized argument to 'provideSecureHost'. Must be a boolean or an object with 'addUniqueHash', 'subdomain', and/or 'domain' properties.`
                    )
                );
            }
            const { hostname, ports, ssl } = await configureHost(hostConf);

            devServerConfig.host = hostname;
            devServerConfig.https = ssl;
            // workaround for https://github.com/webpack/webpack-dev-server/issues/1491
            devServerConfig.https.spdy = {
                protocols: ['http/1.1']
            };

            const requestedPort =
                process.env.PWA_STUDIO_PORTS_DEVELOPMENT || ports.development;
            if (
                (await portscanner.checkPortStatus(requestedPort)) === 'closed'
            ) {
                devServerConfig.port = requestedPort;
            } else {
                log.warn(
                    `This project's dev server is configured to run at ${hostname}:${requestedPort}, but port ${requestedPort} is in use. The dev server will run temporarily on port ${highlight(
                        devServerConfig.port
                    )}; you may see inconsistent ServiceWorker behavior.`
                );
            }
        } else {
            log.warn(secureHostWarning + helpText);
        }

        const { graphqlPlayground } = config;
        if (graphqlPlayground) {
            const { queryDirs = [] } = config.graphqlPlayground;
            const endpoint = '/graphql';

            const queryDirListings = await Promise.all(
                queryDirs.map(async dir => {
                    const files = await readdir(dir);
                    return { dir, files };
                })
            );

            const queryDirContents = await Promise.all(
                queryDirListings.map(({ dir, files }) =>
                    Promise.all(
                        files.map(async queryFile => {
                            const fileAbsPath = resolve(dir, queryFile);
                            const query = await readFile(fileAbsPath, 'utf8');
                            const name = relative(process.cwd(), fileAbsPath);
                            return {
                                endpoint,
                                name,
                                query
                            };
                        })
                    )
                )
            );
            const tabs = [].concat(...queryDirContents); // flatten

            const oldBefore = devServerConfig.before;
            devServerConfig.before = app => {
                oldBefore(app);
                // this middleware has a bad habit of calling next() when it
                // should not, so let's give it a noop next()
                const noop = () => {};
                const middleware = playgroundMiddleware({
                    endpoint,
                    tabs
                });
                app.get('/graphiql', (req, res) => middleware(req, res, noop));
            };
        }

        // Public path must be an absolute URL to enable hot module replacement
        devServerConfig.publicPath = url.format({
            protocol: devServerConfig.https ? 'https:' : 'http:',
            hostname: devServerConfig.host,
            port: devServerConfig.port,
            // ensure trailing slash
            pathname: config.publicPath.replace(/([^\/])$/, '$1/')
        });

        return devServerConfig;
    }
};
module.exports = PWADevServer;
