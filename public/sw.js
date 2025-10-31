// sw.js

const METADATA_CACHE_NAME = 'pwa-metadata-cache-v1';
const DATA_CACHE_NAME = 'pwa-data-cache-v1';
const EXTENSION_PATH_PREFIX = '/scripts/extensions/';

const LOG_PREFIX = '[Service Worker]';

/**
 * Clean cache for a specific path prefix.
 * 
 * @param {string} pathPrefix The path prefix to clear from the cache.
 */
async function clearCacheForPath(pathPrefix) {
    console.log(`${LOG_PREFIX} Clearing cache for path: ${pathPrefix}`);
    try {
        const dataCache = await caches.open(DATA_CACHE_NAME);
        const cachedRequests = await dataCache.keys();
        const deletePromises = cachedRequests
            .filter(req => new URL(req.url).pathname.startsWith(pathPrefix))
            .map(req => {
                console.log(`${LOG_PREFIX} Deleting from cache: ${req.url}`);
                return dataCache.delete(req);
            });
        await Promise.all(deletePromises);
        console.log(`${LOG_PREFIX} Cache cleared for path: ${pathPrefix}`);
    } catch (error) {
        console.error(`${LOG_PREFIX} Error clearing cache for path ${pathPrefix}:`, error);
    }
}

/**
 * Checks if a URL belongs to an extension and returns its base path.
 * e.g., for "://.../scripts/extensions/third-party/my-ext/main.js",
 * it returns "/scripts/extensions/third-party/my-ext/".
 * 
 * @param {URL} url The URL object to check.
 * @returns {string|null} The extension's base path or null if it's not an extension URL.
 */
function getExtensionPath(url) {
    if (url.pathname.startsWith(EXTENSION_PATH_PREFIX)) {
        // Regex to match '/scripts/extensions/(third-party|local)/<extension-name>/'
        const match = url.pathname.match(`^(${EXTENSION_PATH_PREFIX}(?:third-party|local)/[^/]+/)`);
        return match ? match[1] : null;
    }
    return null;
}

self.addEventListener('install', (/** @type {InstallEvent} */ event) => {
    console.log(`${LOG_PREFIX} Install event`);
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (/** @type {ActivateEvent} */ event) => {
    console.log(`${LOG_PREFIX} Activate event`);
    event.waitUntil(
        (async () => {
            await self.clients.claim();
            try {
                // Global version check to invalidate all caches on major updates
                const response = await fetch('/version');
                if (!response.ok) throw new Error(`Failed to fetch /version: ${response.statusText}`);

                const versionInfo = await response.json();
                const newGlobalVersion = versionInfo.gitRevision;
                if (!newGlobalVersion) {
                    console.warn(`${LOG_PREFIX} gitRevision not found in /version response.`);
                    return;
                }

                const globalVersionCacheKey = new URL('/pwa-metadata/global-version', self.location.origin).href;
                const metadataCache = await caches.open(METADATA_CACHE_NAME);
                const oldVersionResponse = await metadataCache.match(globalVersionCacheKey);
                const oldGlobalVersion = oldVersionResponse ? await oldVersionResponse.text() : null;

                console.log(`${LOG_PREFIX} New global version: ${newGlobalVersion}, Old global version: ${oldGlobalVersion}`);

                if (newGlobalVersion !== oldGlobalVersion) {
                    console.log(`${LOG_PREFIX} Global version mismatch. Clearing ALL caches.`);
                    const cacheNames = await caches.keys();
                    await Promise.all(cacheNames.map(name => caches.delete(name)));

                    const newMetadataCache = await caches.open(METADATA_CACHE_NAME);
                    await newMetadataCache.put(globalVersionCacheKey, new Response(newGlobalVersion));
                    console.log(`${LOG_PREFIX} All caches cleared and new global version stored.`);
                } else {
                    console.log(`${LOG_PREFIX} Global version is up to date.`);
                }
            } catch (error) {
                console.error(`${LOG_PREFIX} Error during global version check:`, error);
            }
        })()
    );
});


/**
 * Implements a cache-first, then network fallback strategy.
 * Also caches the network response if the request is successful.
 * @param {Request} request The request to handle.
 * @returns {Promise<Response>}
 */
async function cacheFirstNetworkFallback(request) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
        return cachedResponse;
    }

    try {
        const networkResponse = await fetch(request);
        // Cache successful GET requests
        if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            const cache = await caches.open(DATA_CACHE_NAME);
            cache.put(request, responseToCache);
        }
        return networkResponse;
    } catch (error) {
        console.error(`${LOG_PREFIX} Fetch failed for ${request.url}:`, error);
        // Optional: Return a fallback page/response on network failure
        throw error;
    }
}


/**
 * Handles cacheable fetch requests, respecting extension-specific cache settings.
 * @param {FetchEvent} event The fetch event.
 * @returns {Promise<Response>}
 */
async function handleCacheableRequest(event) {
    const url = new URL(event.request.url);
    const extensionPath = getExtensionPath(url);

    // If the request is for an extension asset, check its cache setting
    if (extensionPath) {
        const metadataCache = await caches.open(METADATA_CACHE_NAME);
        const cacheSettingKey = new URL(`/pwa-metadata/cache-setting${extensionPath}manifest.json`, self.location.origin).href;
        const cacheSettingResponse = await metadataCache.match(cacheSettingKey);

        // Default to enabled if not set. Only disable if explicitly set to 'false'.
        const isCacheEnabled = cacheSettingResponse ? (await cacheSettingResponse.text()) === 'true' : true;

        if (!isCacheEnabled) {
            console.log(`${LOG_PREFIX} Caching is disabled for extension at '${extensionPath}'. Fetching from network: ${url.pathname}`);
            return fetch(event.request);
        }
    }

    // For non-extensions or cache-enabled extensions, use the standard strategy
    return cacheFirstNetworkFallback(event.request);
}


self.addEventListener('fetch', (/** @type {FetchEvent} */ event) => {
// Ignore non-GET requests
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Ignore non-http requests and specific API/dynamic paths
    if (!url.protocol.startsWith('http')) return;
    const ignoredPaths = ['/api/', '/thumbnail', '/csrf-token', '/version'];
    if (ignoredPaths.some(path => url.pathname.startsWith(path))) {
        return;
    }

    // Special handling for manifest.json files to check for updates and cache settings
    if (url.pathname.endsWith('/manifest.json')) {
        event.respondWith(handleManifestRequest(event));
        return;
    }

    // Handle all other cacheable requests
    event.respondWith(handleCacheableRequest(event));
});

/**
 * Handles manifest.json requests to check for version updates and cache settings.
 * @param {FetchEvent} event The fetch event for a manifest.json file.
 */
async function handleManifestRequest(event) {
    console.log(`${LOG_PREFIX} Handling manifest request: ${event.request.url}`);
    try {
        const networkResponse = await fetch(event.request);
        if (!networkResponse.ok) return networkResponse;

        const responseForClient = networkResponse.clone();
        const responseForSW = networkResponse.clone();

        const manifestData = await responseForSW.json();
        const extensionPath = new URL(event.request.url).pathname.replace(/manifest\.json$/, '');

        const isCacheEnabled = manifestData.cache !== false;

        const metadataCache = await caches.open(METADATA_CACHE_NAME);
        const versionCacheKey = new URL(`/pwa-metadata/version${extensionPath}manifest.json`, self.location.origin).href;
        const cacheSettingKey = new URL(`/pwa-metadata/cache-setting${extensionPath}manifest.json`, self.location.origin).href;

        if (isCacheEnabled) {
            console.log(`${LOG_PREFIX} Caching is ENABLED for extension at '${extensionPath}'.`);
            const newExtensionVersion = manifestData.version;
            if (!newExtensionVersion) {
                console.warn(`${LOG_PREFIX} 'version' field not found in ${event.request.url}`);
                // Still store cache setting even if version is missing
                await metadataCache.put(cacheSettingKey, new Response('true'));
                return responseForClient;
            }

            const oldVersionResponse = await metadataCache.match(versionCacheKey);
            const oldExtensionVersion = oldVersionResponse ? await oldVersionResponse.text() : null;

            console.log(`${LOG_PREFIX} Extension at '${extensionPath}': New version=${newExtensionVersion}, Old version=${oldExtensionVersion}`);

            if (newExtensionVersion !== oldExtensionVersion) {
                console.log(`${LOG_PREFIX} Version mismatch for extension at '${extensionPath}'. Clearing its cache.`);
                await clearCacheForPath(extensionPath);
                await metadataCache.put(versionCacheKey, new Response(newExtensionVersion));
            }
            // Store that caching is enabled for this extension
            await metadataCache.put(cacheSettingKey, new Response('true'));

        } else {
            console.log(`${LOG_PREFIX} Caching is DISABLED for extension at '${extensionPath}'. Clearing its cache and metadata.`);
            // If caching is disabled, clear any existing cache for this extension.
            await clearCacheForPath(extensionPath);
            // Remove its version record from metadata
            await metadataCache.delete(versionCacheKey);
            // Store that caching is disabled for this extension
            await metadataCache.put(cacheSettingKey, new Response('false'));
        }

        return responseForClient;
    } catch (error) {
        console.error(`${LOG_PREFIX} Error handling manifest request for ${event.request.url}:`, error);
        // On error, fall back to a direct network request
        return fetch(event.request);
    }
}
