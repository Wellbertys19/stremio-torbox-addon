const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 7000;
const TORBOX_API = 'https://api.torbox.app/v1/api';

// Trackers públicos para acelerar o carregamento quando usado SEM TorBox (Modo P2P)
const PUBLIC_TRACKERS = [
    'dht:6881',
    'tracker:udp://tracker.opentrackr.org:1337/announce',
    'tracker:udp://open.demonii.com:1337/announce',
    'tracker:udp://open.stealth.si:80/announce',
    'tracker:udp://exodus.desync.com:6969/announce',
    'tracker:udp://tracker.torrent.eu.org:451/announce',
    'tracker:http://tracker.openbittorrent.com:80/announce'
];

// Indexadores consultados simultaneamente
const DEFAULT_INDEXERS = [
    {
        name: 'Torrentio PT-BR',
        url: 'https://torrentio.strem.fun/providers=comando,bludv,lapumia,micoleaodublado,nyaasi,tokyotosho|language=portuguese',
        isNativePtBr: false
    },
    {
        name: 'Brazuca Torrents',
        url: 'https://94c8cb9f702d-brazuca-torrents.baby-beamup.club',
        isNativePtBr: true
    },
    {
        name: 'MediaFusion',
        url: 'https://mediafusion.elfhosted.com',
        isNativePtBr: false
    }
];

// ==========================================
// 1. UTILITÁRIOS DE CONFIGURAÇÃO E MANIFESTO
// ==========================================

function decodeConfig(configStr) {
    if (!configStr) return { mode: 'p2p' };
    try {
        return JSON.parse(Buffer.from(configStr, 'base64url').toString('utf8'));
    } catch {
        return { mode: 'p2p' };
    }
}

function buildManifest(config = {}) {
    const mode = config.mode || (config.apiKey ? 'torbox' : 'p2p');
    let addonName = 'TorBox & P2P PT-BR 🇧🇷';
    if (mode === 'p2p') addonName = 'Stremio PT-BR (P2P Gratuito) 🇧🇷';
    if (mode === 'torbox') addonName = 'TorBox PT-BR Pro 🇧🇷';
    if (mode === 'hybrid') addonName = 'TorBox + P2P PT-BR 🇧🇷';

    return {
        id: 'org.community.torbox.ptbr.pro',
        version: '2.1.0',
        name: addonName,
        description: 'Catálogos e Streams de Filmes, Séries e Animes em PT-BR (4K/1080p/720p) com opção P2P Gratuito ou API TorBox.',
        resources: ['catalog', 'stream'],
        types: ['movie', 'series', 'anime'],
        idPrefixes: ['tt', 'kitsu'],
        catalogs: [
            {
                type: 'movie',
                id: 'torbox_ptbr_movies',
                name: 'Filmes em Alta 🇧🇷',
                extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
            },
            {
                type: 'series',
                id: 'torbox_ptbr_series',
                name: 'Séries em Alta 🇧🇷',
                extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
            },
            {
                type: 'anime',
                id: 'torbox_ptbr_animes',
                name: 'Animes Populares 🇧🇷',
                extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
            }
        ],
        behaviorHints: {
            configurable: true,
            configurationRequired: false // Permite usar sem configurar nada (vai direto para o P2P)
        }
    };
}

// ==========================================
// 2. FILTROS PT-BR E ORDENAÇÃO DE QUALIDADE
// ==========================================

function isPtBrStream(text, onlyDubbed = false, isNativePtBrSource = false) {
    if (!text) return false;

    const dubRegex = /(🇧🇷|\bdublado\b|\bdub\b|\bdual[-_. ]?audio\b|\bdual\b|\bnacional\b|\baudio\s*pt\b|\bpt[-_. ]?br\s*dub\b)/i;
    if (onlyDubbed) {
        return dubRegex.test(text);
    }

    if (isNativePtBrSource) return true;

    const ptbrRegex = /(🇧🇷|\bpt[-_. ]?br\b|\bportugues(e)?\b|\bportuguês\b|\bdublado\b|\bdub\b|\bdual[-_. ]?audio\b|\bdual\b|\bnacional\b|\blegendado\b|\bleg\s*pt\b|\bbrazil(ian)?\b)/i;
    return ptbrRegex.test(text);
}

function analyzeQuality(title = '') {
    const t = title.toLowerCase();
    let resolution = 'SD';
    let score = 100;

    if (/\b(2160p|4k|uhd)\b/i.test(t)) {
        resolution = '4K';
        score = 400;
    } else if (/\b(1080p|fhd|full\s*hd)\b/i.test(t)) {
        resolution = '1080p';
        score = 300;
    } else if (/\b(720p|hd)\b/i.test(t)) {
        resolution = '720p';
        score = 200;
    } else if (/\b(480p|360p)\b/i.test(t)) {
        resolution = '480p';
        score = 100;
    }

    const isDub = /(\bdublado\b|\bdub\b|\bdual\b|\bnacional\b)/i.test(t);
    if (isDub) score += 50;

    if (/\b(hdr|dv|dolby\s*vision|hevc|x265|10bit)\b/i.test(t)) score += 15;

    return { resolution, score, isDub };
}

function extractInfoHash(streamObj) {
    if (streamObj.infoHash && /^[a-fA-F0-9]{40}$/.test(streamObj.infoHash)) {
        return streamObj.infoHash.toLowerCase();
    }
    const rawText = `${streamObj.url || ''} ${streamObj.externalUrl || ''} ${JSON.stringify(streamObj.sources || [])}`;
    const match = rawText.match(/\b([a-fA-F0-9]{40})\b/);
    return match ? match[1].toLowerCase() : null;
}

// ==========================================
// 3. CATÁLOGOS EM PORTUGUÊS (FILMES, SÉRIES, ANIMES)
// ==========================================

async function fetchAnimesCatalog(searchQuery = '', skip = 0) {
    try {
        const params = {
            'page[limit]': 20,
            'page[offset]': skip
        };
        if (searchQuery) {
            params['filter[text]'] = searchQuery;
        } else {
            params['sort'] = '-userCount';
        }

        const res = await axios.get('https://kitsu.io/api/edge/anime', { params, timeout: 7000 });
        const items = res.data?.data || [];

        return items.map(item => {
            const attr = item.attributes || {};
            return {
                id: `kitsu:${item.id}`,
                type: 'anime',
                name: attr.titles?.pt_br || attr.titles?.en || attr.canonicalTitle || 'Anime',
                poster: attr.posterImage?.medium || attr.posterImage?.original || '',
                description: attr.synopsis || '',
                releaseInfo: attr.startDate ? attr.startDate.split('-')[0] : ''
            };
        });
    } catch {
        return [];
    }
}

async function fetchMoviesOrSeriesCatalog(type, searchQuery = '', skip = 0, tmdbKey = '') {
    try {
        const baseUrl = searchQuery
            ? `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(searchQuery)}.json`
            : `https://v3-cinemeta.strem.io/catalog/${type}/top/skip=${skip}.json`;

        const res = await axios.get(baseUrl, { timeout: 7000 });
        const metas = (res.data?.metas || []).slice(0, 20);

        if (tmdbKey) {
            const translated = await Promise.all(
                metas.map(async (meta) => {
                    try {
                        const imdbId = meta.id.split(':')[0];
                        const findRes = await axios.get(
                            `https://api.themoviedb.org/3/find/${imdbId}`,
                            {
                                params: { api_key: tmdbKey, external_source: 'imdb_id', language: 'pt-BR' },
                                timeout: 4000
                            }
                        );
                        const match = type === 'movie'
                            ? findRes.data?.movie_results?.[0]
                            : findRes.data?.tv_results?.[0];

                        if (match) {
                            return {
                                ...meta,
                                name: match.title || match.name || meta.name,
                                poster: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : meta.poster,
                                description: match.overview || meta.description
                            };
                        }
                    } catch {}
                    return meta;
                })
            );
            return translated;
        }

        return metas;
    } catch {
        return [];
    }
}

// ==========================================
// 4. INTEGRAÇÃO COM TORBOX E MÚLTIPLOS INDEXADORES
// ==========================================

async function getMediaMetadata(type, idPrefix, rawId) {
    try {
        if (idPrefix === 'kitsu') {
            const kitsuId = rawId.split(':')[1];
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 5000 });
            const attrs = res.data?.data?.attributes;
            return {
                title: attrs?.canonicalTitle || attrs?.titles?.en_jp || '',
                year: attrs?.startDate ? attrs.startDate.split('-')[0] : ''
            };
        } else {
            const imdbId = rawId.split(':')[0];
            const metaType = type === 'movie' ? 'movie' : 'series';
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${metaType}/${imdbId}.json`, { timeout: 5000 });
            return {
                title: res.data?.meta?.name || '',
                year: res.data?.meta?.releaseInfo?.split('–')[0] || ''
            };
        }
    } catch {
        return { title: '', year: '' };
    }
}

async function checkTorBoxCache(apiKey, hashes) {
    if (!apiKey || !hashes.length) return {};
    try {
        const batch = hashes.slice(0, 100).join(',');
        const res = await axios.get(`${TORBOX_API}/torrents/checkcached`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            params: { hash: batch, format: 'object', list_files: true },
            timeout: 8000
        });
        return res.data?.data || {};
    } catch {
        return {};
    }
}

async function searchUserTorBoxCloud(apiKey, queryTitle, onlyDubbed) {
    if (!apiKey || !queryTitle) return [];
    try {
        const res = await axios.get(`${TORBOX_API}/torrents/mylist`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            params: { bypass_cache: false },
            timeout: 7000
        });
        const list = res.data?.data || [];
        const normalizedQuery = queryTitle.toLowerCase();
        return list
            .filter(item => {
                const matchesTitle = item.download_present && item.name.toLowerCase().includes(normalizedQuery);
                return matchesTitle && isPtBrStream(item.name, onlyDubbed, false);
            })
            .map(item => ({
                infoHash: item.hash.toLowerCase(),
                title: `🇧🇷 [Nuvem Pessoal] ${item.name}`,
                fileIdx: null,
                source: 'TorBox Cloud'
            }));
    } catch {
        return [];
    }
}

async function fetchCandidateTorrents(type, id, customIndexerUrls, apiKey, metadata, onlyDubbed) {
    const results = [];

    if (apiKey && metadata.title) {
        const cloudItems = await searchUserTorBoxCloud(apiKey, metadata.title, onlyDubbed);
        results.push(...cloudItems);
    }

    const activeIndexers = [...DEFAULT_INDEXERS];
    if (customIndexerUrls) {
        const extras = customIndexerUrls.split(',').map(u => u.trim()).filter(Boolean);
        for (const url of extras) {
            if (!activeIndexers.some(idx => idx.url === url)) {
                activeIndexers.push({ name: 'Custom Indexer', url, isNativePtBr: false });
            }
        }
    }

    const queryTypes = id.startsWith('kitsu') ? ['anime', 'series'] : [type];

    const requests = [];
    for (const indexer of activeIndexers) {
        const cleanBase = indexer.url.replace(/\/$/, '');
        for (const qType of queryTypes) {
            const streamUrl = `${cleanBase}/stream/${qType}/${encodeURIComponent(id)}.json`;
            requests.push(
                axios.get(streamUrl, { timeout: 7500 })
                    .then(res => ({ indexer, streams: res.data?.streams || [] }))
                    .catch(() => ({ indexer, streams: [] }))
            );
        }
    }

    const responses = await Promise.allSettled(requests);

    for (const r of responses) {
        if (r.status !== 'fulfilled') continue;
        const { indexer, streams } = r.value;

        for (const s of streams) {
            const hash = extractInfoHash(s);
            if (!hash) continue;

            const fullText = `${s.name || ''} ${s.title || ''} ${s.description || ''}`;
            if (isPtBrStream(fullText, onlyDubbed, indexer.isNativePtBr)) {
                const rawTitle = s.title || s.description || s.name || 'Stream PT-BR';
                results.push({
                    infoHash: hash,
                    title: `[${indexer.name}] ${rawTitle}`,
                    fileIdx: s.fileIdx ?? null,
                    source: indexer.name
                });
            }
        }
    }

    const unique = new Map();
    for (const item of results) {
        if (item.infoHash && !unique.has(item.infoHash)) {
            unique.set(item.infoHash, item);
        }
    }
    return Array.from(unique.values());
}

function selectBestVideoFile(files, season, episode) {
    const videoRegex = /\.(mkv|mp4|avi|mov|webm|m4v)$/i;
    const videoFiles = (files || []).filter(f => videoRegex.test(f.name || f.short_name || ''));

    if (!videoFiles.length) return files?.[0] || null;

    if (season !== null && episode !== null) {
        const sPad = String(season).padStart(2, '0');
        const ePad = String(episode).padStart(2, '0');
        const epRegex = new RegExp(`(s${sPad}[._ -]?e${ePad}|${season}x${ePad}|\\bep?[._ -]?${ePad}\\b|\\b-\\s*${ePad}\\b)`, 'i');
        const matched = videoFiles.find(f => epRegex.test(f.name || f.short_name || ''));
        if (matched) return matched;
    }

    return videoFiles.reduce((prev, curr) => (curr.size > prev.size ? curr : prev), videoFiles[0]);
}

// ==========================================
// 5. PÁGINA DE CONFIGURAÇÃO INTERATIVA
// ==========================================

app.get(['/', '/configure', '/:config/configure'], (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <title>Stremio PT-BR Addon (P2P & TorBox)</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 1rem; }
            .card { background: #1e293b; padding: 2rem; border-radius: 12px; width: 100%; max-width: 490px; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
            h2 { margin-top: 0; color: #4ade80; }
            .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 1rem; }
            .badge { background: #334155; color: #38bdf8; padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: bold; }
            label { display: block; margin-top: 1rem; font-size: 0.9rem; color: #cbd5e1; font-weight: 500; }
            select, input[type="text"], input[type="password"] { width: 100%; padding: 0.75rem; margin-top: 0.4rem; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 0.95rem; }
            .torbox-box { background: #0f172a80; border: 1px solid #334155; padding: 1rem; border-radius: 8px; margin-top: 1rem; }
            .checkbox-label { display: flex; align-items: center; gap: 8px; margin-top: 0.8rem; cursor: pointer; font-size: 0.9rem; font-weight: normal; }
            button { width: 100%; margin-top: 1.5rem; padding: 0.85rem; background: #16a34a; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: bold; cursor: pointer; }
            button:hover { background: #15803d; }
            .hint { font-size: 0.78rem; color: #94a3b8; margin-top: 0.3rem; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>🇧🇷 Stremio PT-BR Pro 2.1</h2>
            <div class="badges">
                <span class="badge">Modo Sem TorBox (P2P)</span>
                <span class="badge">Modo TorBox API</span>
                <span class="badge">Catálogos PT-BR</span>
                <span class="badge">4K / 1080p / 720p</span>
            </div>
            
            <label>Como você deseja assistir?</label>
            <select id="mode" onchange="toggleMode()">
                <option value="p2p">🌐 Sem API TorBox (Modo P2P Torrent Gratuito)</option>
                <option value="torbox">⚡ Usar API do TorBox (Cache Instantâneo Debrid)</option>
                <option value="hybrid">🔀 Modo Híbrido (Mostrar links TorBox + links P2P)</option>
            </select>

            <div id="torboxSection" class="torbox-box" style="display: none;">
                <label style="margin-top: 0;">TorBox API Key:</label>
                <input type="password" id="apiKey" placeholder="Cole sua chave da conta TorBox..." />
                
                <label class="checkbox-label">
                    <input type="checkbox" id="cachedOnly" checked />
                    Mostrar apenas streams em cache instantâneo ([TB+])
                </label>
            </div>
            
            <label>TMDB API Key (Opcional - Traduz capas e sinopses para PT-BR):</label>
            <input type="text" id="tmdbKey" placeholder="Opcional: deixe em branco para usar catálogo padrão" />

            <label>Indexadores Extras Opcionais (separados por vírgula):</label>
            <input type="text" id="customIndexers" placeholder="Opcional: Torrentio, Brazuca e MediaFusion já inclusos" />
            <div class="hint">Torrentio PT-BR, Brazuca Torrents e MediaFusion já vêm ativados por padrão.</div>

            <label class="checkbox-label">
                <input type="checkbox" id="onlyDubbed" />
                Apenas Dublado / Dual Áudio (Ocultar apenas legendados)
            </label>

            <button onclick="install()">Instalar no Stremio</button>
        </div>
        <script>
            function toggleMode() {
                const mode = document.getElementById('mode').value;
                const tbSection = document.getElementById('torboxSection');
                tbSection.style.display = (mode === 'p2p') ? 'none' : 'block';
            }

            function install() {
                const mode = document.getElementById('mode').value;
                const apiKey = mode === 'p2p' ? '' : document.getElementById('apiKey').value.trim();
                const tmdbKey = document.getElementById('tmdbKey').value.trim();
                const indexerUrl = document.getElementById('customIndexers').value.trim();
                const onlyDubbed = document.getElementById('onlyDubbed').checked;
                const cachedOnly = document.getElementById('cachedOnly').checked;

                if ((mode === 'torbox' || mode === 'hybrid') && !apiKey) {
                    alert('Por favor, insira sua TorBox API Key ou mude a opção acima para "Sem API TorBox (Modo P2P)".');
                    return;
                }
                
                const config = { mode, apiKey, tmdbKey, indexerUrl, onlyDubbed, cachedOnly };
                const encoded = btoa(JSON.stringify(config)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
                const stremioUrl = 'stremio://' + window.location.host + '/' + encoded + '/manifest.json';
                window.location.href = stremioUrl;
            }
        </script>
    </body>
    </html>
    `);
});

// ==========================================
// 6. ROTAS DO STREMIO (COM E SEM CONFIGURAÇÃO)
// ==========================================

app.get('/manifest.json', (req, res) => {
    res.json(buildManifest({ mode: 'p2p' }));
});

app.get('/:config/manifest.json', (req, res) => {
    const config = decodeConfig(req.params.config);
    res.json(buildManifest(config));
});

// Rotas de Catálogo (funcionam tanto com /:config quanto direto na raiz)
async function handleCatalogRequest(req, res) {
    const { config: configStr, type, extra } = req.params;
    const config = decodeConfig(configStr);

    let searchQuery = '';
    let skip = 0;

    if (extra) {
        const searchMatch = extra.match(/search=([^&]+)/);
        const skipMatch = extra.match(/skip=(\d+)/);
        if (searchMatch) searchQuery = decodeURIComponent(searchMatch[1]);
        if (skipMatch) skip = parseInt(skipMatch[1], 10);
    }

    if (type === 'anime') {
        const metas = await fetchAnimesCatalog(searchQuery, skip);
        return res.json({ metas });
    }

    const metas = await fetchMoviesOrSeriesCatalog(type, searchQuery, skip, config.tmdbKey);
    res.json({ metas });
}

app.get([
    '/catalog/:type/:id.json',
    '/catalog/:type/:id/:extra.json',
    '/:config/catalog/:type/:id.json',
    '/:config/catalog/:type/:id/:extra.json'
], handleCatalogRequest);

// Rotas de Stream (Suporta Modo P2P, Modo TorBox e Modo Híbrido)
async function handleStreamRequest(req, res) {
    const { config: configStr, type, id } = req.params;
    const config = decodeConfig(configStr);
    const mode = config.mode || (config.apiKey ? 'torbox' : 'p2p');

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = `${protocol}://${req.get('host')}`;

    const parts = id.split(':');
    const idPrefix = id.startsWith('kitsu') ? 'kitsu' : 'tt';
    let season = null;
    let episode = null;

    if (idPrefix === 'kitsu' && parts.length >= 3) {
        season = 1;
        episode = parseInt(parts[2], 10);
    } else if (idPrefix === 'tt' && parts.length >= 3) {
        season = parseInt(parts[1], 10);
        episode = parseInt(parts[2], 10);
    }

    const metadata = await getMediaMetadata(type, idPrefix, id);
    const activeApiKey = (mode === 'torbox' || mode === 'hybrid') ? config.apiKey : '';

    const candidates = await fetchCandidateTorrents(
        type,
        id,
        config.indexerUrl,
        activeApiKey,
        metadata,
        Boolean(config.onlyDubbed)
    );

    if (!candidates.length) {
        return res.json({ streams: [] });
    }

    const scoredStreams = [];

    // 1. Se o modo for TorBox ou Híbrido (e tiver API Key), gera os streams via TorBox
    if ((mode === 'torbox' || mode === 'hybrid') && activeApiKey) {
        const hashes = candidates.map(c => c.infoHash);
        const cachedMap = await checkTorBoxCache(activeApiKey, hashes);

        for (const item of candidates) {
            const isCached = Boolean(cachedMap[item.infoHash]);
            if (config.cachedOnly && !isCached) continue;

            const q = analyzeQuality(item.title);
            const cacheBonus = isCached ? 2000 : 1000;
            const totalScore = cacheBonus + q.score;

            const badge = isCached ? '⚡ [TB+ 🇧🇷]' : '⏳ [TB 🇧🇷]';
            const audioTag = q.isDub ? '🎙️ Dub/Dual' : '💬 PT-BR';
            const resolveUrl = `${host}/${configStr}/resolve/${item.infoHash}/${season ?? 0}/${episode ?? 0}`;

            scoredStreams.push({
                name: `${badge} ${q.resolution}\n${audioTag}`,
                title: item.title,
                url: resolveUrl,
                behaviorHints: {
                    bingeGroup: `torbox-ptbr-${q.resolution}-${isCached ? 'cached' : 'uncached'}`
                },
                _score: totalScore
            });
        }
    }

    // 2. Se o modo for P2P (Sem API TorBox) ou Híbrido, gera os streams Torrent Direto
    if (mode === 'p2p' || mode === 'hybrid' || !activeApiKey) {
        for (const c of candidates) {
            const q = analyzeQuality(c.title);
            const audioTag = q.isDub ? '🎙️ Dub/Dual' : '💬 PT-BR';

            scoredStreams.push({
                name: `🌐 [P2P 🇧🇷] ${q.resolution}\n${audioTag}`,
                title: c.title,
                infoHash: c.infoHash,
                ...(c.fileIdx !== null && c.fileIdx !== undefined ? { fileIdx: c.fileIdx } : {}),
                sources: PUBLIC_TRACKERS,
                behaviorHints: {
                    bingeGroup: `p2p-ptbr-${q.resolution}`
                },
                _score: q.score
            });
        }
    }

    // Ordena por pontuação (TorBox Cache 4K -> 1080p -> P2P 4K -> 1080p -> 720p)
    scoredStreams.sort((a, b) => b._score - a._score);

    const finalStreams = scoredStreams.map(({ _score, ...stream }) => stream);
    res.json({ streams: finalStreams });
}

app.get([
    '/stream/:type/:id.json',
    '/:config/stream/:type/:id.json'
], handleStreamRequest);

// Resolvedor On-Demand do TorBox
app.get('/:config/resolve/:infoHash/:season/:episode', async (req, res) => {
    const { config: configStr, infoHash, season, episode } = req.params;
    const config = decodeConfig(configStr);

    if (!config.apiKey) {
        return res.status(400).send('API Key do TorBox não configurada.');
    }

    try {
        const magnet = `magnet:?xt=urn:btih:${infoHash}`;
        const form = new FormData();
        form.append('magnet', magnet);
        form.append('seed', '1');
        form.append('allow_zip', 'false');

        const createRes = await axios.post(`${TORBOX_API}/torrents/createtorrent`, form, {
            headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${config.apiKey}`
            },
            timeout: 15000
        });

        const torrentId = createRes.data?.data?.torrent_id;
        if (!torrentId) {
            return res.status(404).send('Não foi possível criar o torrent no TorBox.');
        }

        const listRes = await axios.get(`${TORBOX_API}/torrents/mylist`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
            params: { id: torrentId, bypass_cache: true },
            timeout: 10000
        });

        const torrentData = listRes.data?.data;
        const files = torrentData?.files || [];

        const sNum = parseInt(season, 10) > 0 ? parseInt(season, 10) : null;
        const eNum = parseInt(episode, 10) > 0 ? parseInt(episode, 10) : null;

        const targetFile = selectBestVideoFile(files, sNum, eNum);
        if (!targetFile) {
            return res.status(404).send('Nenhum arquivo de vídeo compatível encontrado.');
        }

        const redirectDlUrl = `${TORBOX_API}/torrents/requestdl?token=${encodeURIComponent(config.apiKey)}&torrent_id=${torrentId}&file_id=${targetFile.id}&redirect=true`;
        return res.redirect(302, redirectDlUrl);

    } catch {
        res.status(500).send('Erro ao resolver link junto à API do TorBox.');
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
}

module.exports = app;
