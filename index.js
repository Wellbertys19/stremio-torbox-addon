const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(cors());

// Remove barras duplicadas para evitar erro 404
app.use((req, res, next) => {
    req.url = req.url.replace(/\/+/g, '/');
    next();
});

const PORT = process.env.PORT || 7000;
const TORBOX_API = 'https://api.torbox.app/v1/api';

// =========================================================
// MOTOR DE TRADUÇÃO EM LOTE (SINOPSES + TODOS OS EPISÓDIOS)
// =========================================================

const translationCache = new Map();
const metaTranslationCache = new Map();

const GENRE_TRANSLATIONS = {
    'Action': 'Ação',
    'Adventure': 'Aventura',
    'Animation': 'Animação',
    'Biography': 'Biografia',
    'Comedy': 'Comédia',
    'Crime': 'Crime',
    'Documentary': 'Documentário',
    'Drama': 'Drama',
    'Family': 'Família',
    'Fantasy': 'Fantasia',
    'Film-Noir': 'Noir',
    'History': 'História',
    'Horror': 'Terror',
    'Music': 'Música',
    'Musical': 'Musical',
    'Mystery': 'Mistério',
    'Romance': 'Romance',
    'Sci-Fi': 'Ficção Científica',
    'Science Fiction': 'Ficção Científica',
    'Short': 'Curta',
    'Sport': 'Esporte',
    'Thriller': 'Suspense',
    'War': 'Guerra',
    'Western': 'Faroeste'
};

function translateGenresToPtBr(genres = []) {
    if (!Array.isArray(genres)) return [];
    return genres.map(g => GENRE_TRANSLATIONS[g] || g);
}

// Traduz um único texto para PT-BR
async function translateToPtBr(text) {
    if (!text || typeof text !== 'string') return '';
    const cleanText = text.replace(/\s*\[Written by [^\]]+\]\s*/gi, '').replace(/[\r\n]+/g, ' ').trim();
    if (!cleanText) return '';

    if (translationCache.has(cleanText)) {
        return translationCache.get(cleanText);
    }

    const [translated] = await translateBatchToPtBr([cleanText]);
    return translated || cleanText;
}

// Traduz dezenas de sinopses e títulos de episódios de uma só vez em blocos rápidos
async function translateBatchToPtBr(texts = []) {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const results = new Array(texts.length).fill('');
    const missingIndices = [];
    const missingTexts = [];

    for (let i = 0; i < texts.length; i++) {
        const raw = typeof texts[i] === 'string' ? texts[i] : '';
        const cleaned = raw.replace(/\s*\[Written by [^\]]+\]\s*/gi, '').replace(/[\r\n]+/g, ' ').trim();
        if (!cleaned) {
            results[i] = '';
        } else if (translationCache.has(cleaned)) {
            results[i] = translationCache.get(cleaned);
        } else {
            missingIndices.push(i);
            missingTexts.push(cleaned);
        }
    }

    if (missingTexts.length === 0) return results;

    // Agrupa textos em blocos de até 3200 caracteres (1 linha = 1 episódio)
    const chunks = [];
    let currentChunkTexts = [];
    let currentChunkIndices = [];
    let currentLen = 0;

    for (let i = 0; i < missingTexts.length; i++) {
        const t = missingTexts[i];
        const idx = missingIndices[i];
        if (currentLen + t.length > 3200 && currentChunkTexts.length > 0) {
            chunks.push({ texts: currentChunkTexts, indices: currentChunkIndices });
            currentChunkTexts = [];
            currentChunkIndices = [];
            currentLen = 0;
        }
        currentChunkTexts.push(t);
        currentChunkIndices.push(idx);
        currentLen += t.length + 1;
    }

    if (currentChunkTexts.length > 0) {
        chunks.push({ texts: currentChunkTexts, indices: currentChunkIndices });
    }

    await Promise.all(
        chunks.map(async (chunk) => {
            const joinedPayload = chunk.texts.join('\n');
            try {
                const body = new URLSearchParams({ q: joinedPayload }).toString();
                const res = await axios.post(
                    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=pt&dt=t',
                    body,
                    {
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'User-Agent': 'Mozilla/5.0'
                        },
                        timeout: 6000
                    }
                );

                if (Array.isArray(res.data?.[0])) {
                    const fullTranslated = res.data[0].map(part => part[0]).join('');
                    const translatedLines = fullTranslated.split('\n');

                    for (let j = 0; j < chunk.texts.length; j++) {
                        const original = chunk.texts[j];
                        const targetIdx = chunk.indices[j];
                        const finalStr = (translatedLines[j] || original).trim();
                        if (translationCache.size > 5000) translationCache.clear();
                        translationCache.set(original, finalStr);
                        results[targetIdx] = finalStr;
                    }
                    return;
                }
            } catch {}

            // Fallback se falhar a rede
            for (let j = 0; j < chunk.texts.length; j++) {
                results[chunk.indices[j]] = chunk.texts[j];
            }
        })
    );

    return results;
}

// =========================================================
// HISTÓRICO "CONTINUE ASSISTINDO"
// =========================================================

const recentlyWatched = {
    movie: [],
    series: []
};

function addToContinueWatching(type, metaObj) {
    if (!metaObj || !metaObj.id || !metaObj.name) return;
    const targetType = type === 'movie' ? 'movie' : 'series';
    const list = recentlyWatched[targetType];
    const cleanId = metaObj.id.split(':')[0];
    const existingIdx = list.findIndex(item => item.id === cleanId);
    if (existingIdx !== -1) list.splice(existingIdx, 1);
    list.unshift({
        id: cleanId,
        type: targetType,
        name: metaObj.name,
        poster: metaObj.poster || `https://images.metahub.space/poster/medium/${cleanId}/img`,
        background: metaObj.background || `https://images.metahub.space/background/medium/${cleanId}/img`,
        description: metaObj.description || '',
        releaseInfo: metaObj.releaseInfo || ''
    });
    if (list.length > 20) list.pop();
}

const PUBLIC_TRACKERS = [
    'dht:6881',
    'tracker:udp://tracker.opentrackr.org:1337/announce',
    'tracker:udp://open.demonii.com:1337/announce',
    'tracker:udp://open.stealth.si:80/announce',
    'tracker:udp://exodus.desync.com:6969/announce',
    'tracker:udp://tracker.torrent.eu.org:451/announce',
    'tracker:http://tracker.openbittorrent.com:80/announce'
];

const DEFAULT_INDEXERS = [
    {
        name: 'Torrentio',
        url: 'https://torrentio.strem.fun/providers=comando,bludv,lapumia,micoleaodublado,nyaasi,tokyotosho|language=portuguese',
        isNativePtBr: false
    },
    {
        name: 'Brazuca',
        url: 'https://94c8cb9f702d-brazuca-torrents.baby-beamup.club',
        isNativePtBr: true
    },
    {
        name: 'MediaFusion',
        url: 'https://mediafusion.elfhosted.com',
        isNativePtBr: false
    }
];

const GENRE_OPTIONS = [
    'Action',
    'Adventure',
    'Animation',
    'Comedy',
    'Crime',
    'Drama',
    'Fantasy',
    'Horror',
    'Mystery',
    'Romance',
    'Sci-Fi',
    'Thriller'
];

function decodeConfig(configStr) {
    if (!configStr || configStr === 'configure') return { mode: 'p2p' };
    try {
        const b64 = configStr.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } catch {
        return { mode: 'p2p' };
    }
}

function buildManifest(config = {}) {
    const mode = config.mode || (config.apiKey ? 'torbox' : 'p2p');
    let addonName = 'Stremio PT-BR Pro';
    if (mode === 'p2p') addonName = 'Stremio PT-BR (P2P)';
    if (mode === 'torbox') addonName = 'TorBox PT-BR Pro';
    if (mode === 'hybrid') addonName = 'TorBox + P2P PT-BR';

    return {
        id: 'org.community.torbox.ptbr.pro',
        version: '3.3.0',
        name: addonName,
        description: 'Catálogos, Episódios e Sinopses 100% em Português (Filmes, Séries e Animes) com TorBox e P2P.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['movie', 'series', 'anime'],
        idPrefixes: ['tt', 'kitsu'],
        catalogs: [
            {
                type: 'movie',
                id: 'ptbr_rec_movies',
                name: 'Recomendados para Você',
                extra: [
                    { name: 'genre', isRequired: false, options: GENRE_OPTIONS },
                    { name: 'search', isRequired: false },
                    { name: 'skip', isRequired: false }
                ]
            },
            {
                type: 'series',
                id: 'ptbr_rec_series',
                name: 'Recomendados para Você',
                extra: [
                    { name: 'genre', isRequired: false, options: GENRE_OPTIONS },
                    { name: 'search', isRequired: false },
                    { name: 'skip', isRequired: false }
                ]
            },
            {
                type: 'movie',
                id: 'ptbr_continue_movies',
                name: 'Continue Assistindo',
                extra: [{ name: 'skip', isRequired: false }]
            },
            {
                type: 'series',
                id: 'ptbr_continue_series',
                name: 'Continue Assistindo',
                extra: [{ name: 'skip', isRequired: false }]
            },
            {
                type: 'movie',
                id: 'ptbr_top_movies',
                name: 'Melhores Avaliados (IMDb)',
                extra: [
                    { name: 'genre', isRequired: false, options: GENRE_OPTIONS },
                    { name: 'skip', isRequired: false }
                ]
            },
            {
                type: 'series',
                id: 'ptbr_top_series',
                name: 'Melhores Avaliados (IMDb)',
                extra: [
                    { name: 'genre', isRequired: false, options: GENRE_OPTIONS },
                    { name: 'skip', isRequired: false }
                ]
            },
            {
                type: 'anime',
                id: 'ptbr_rec_animes',
                name: 'Animes Recomendados para Você',
                extra: [
                    { name: 'search', isRequired: false },
                    { name: 'skip', isRequired: false }
                ]
            }
        ],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };
}

function isPtBrStream(text, onlyDubbed = false, isNativePtBrSource = false) {
    if (!text) return false;
    const dubRegex = /(🇧🇷|\bdublado\b|\bdub\b|\bdual[-_. ]?audio\b|\bdual\b|\bnacional\b|\baudio\s*pt\b|\bpt[-_. ]?br\s*dub\b)/i;
    if (onlyDubbed) return dubRegex.test(text);
    if (isNativePtBrSource) return true;
    const ptbrRegex = /(🇧🇷|🇵🇹|\bpt[-_. ]?br\b|\bportugues(e)?\b|\bportuguês\b|\bdublado\b|\bdub\b|\bdual[-_. ]?audio\b|\bdual\b|\bnacional\b|\blegendado\b|\bleg\s*pt\b|\bbrazil(ian)?\b)/i;
    return ptbrRegex.test(text);
}

// =========================================================
// FORMATADOR CUSTOMIZADO (⚡ TORBOX & 🧲 P2P)
// =========================================================

function parseAndFormatStream(rawTitle = '', season = null) {
    const seedsMatch = rawTitle.match(/👤\s*(\d+)/);
    const seeds = seedsMatch ? parseInt(seedsMatch[1], 10) : 0;

    const sizeMatch = rawTitle.match(/(?:💾\s*)?(\d+(?:[.,]\d+)?\s*(?:GB|MB|GiB|MiB))/i);
    const sizeText = sizeMatch ? sizeMatch[1].toUpperCase().replace('GIB', 'GB').replace('MIB', 'MB') : 'Tamanho N/D';

    let wrongSeasonPenalty = 0;
    const firstLine = rawTitle.split('\n')[0] || '';
    if (season !== null) {
        const seasonMention = firstLine.match(/(\d+)\s*[ªa°]?\s*temporada|\bs0?(\d+)\b/i);
        if (seasonMention) {
            const foundSeason = parseInt(seasonMention[1] || seasonMention[2], 10);
            if (foundSeason !== season && !/todas\s*temporada|completa/i.test(firstLine)) {
                wrongSeasonPenalty = -500;
            }
        }
    }

    let resolution = 'HD';
    let score = 150;
    if (/\b(2160p|4k|uhd)\b/i.test(rawTitle)) {
        resolution = '4K';
        score = 400;
    } else if (/\b(1080p|fhd|full\s*hd)\b/i.test(rawTitle)) {
        resolution = '1080p';
        score = 300;
    } else if (/\b(720p|hd)\b/i.test(rawTitle)) {
        resolution = '720p';
        score = 200;
    } else if (/\b(480p|360p)\b/i.test(rawTitle)) {
        resolution = '480p';
        score = 100;
    }

    const isDubOrDual = /(\bdublado\b|\bdub\b|\bdual[-_. ]?audio\b|\bdual\b|\bnacional\b)/i.test(rawTitle);
    const audioLabel = isDubOrDual ? 'Dublado' : 'Legendado';
    if (isDubOrDual) score += 50;

    const qualityTokens = [];
    const tokenMap = [
        { regex: /\bbdrip\b/i, label: 'BDRip' },
        { regex: /\bbrrip\b/i, label: 'BRRip' },
        { regex: /\bblu-?ray\b/i, label: 'BluRay' },
        { regex: /\bweb-?dl\b/i, label: 'WEB-DL' },
        { regex: /\bwebrip\b/i, label: 'WEBRip' },
        { regex: /\bhdtv\b/i, label: 'HDTV' },
        { regex: /\bdvdrip\b/i, label: 'DVDRip' },
        { regex: /\bremux\b/i, label: 'Remux' },
        { regex: /\b(hdr|hdr10)\b/i, label: 'HDR' },
        { regex: /\b(dv|dolby\s*vision)\b/i, label: 'Dolby Vision' },
        { regex: /\b(hevc|x265)\b/i, label: 'x265' }
    ];

    for (const item of tokenMap) {
        if (item.regex.test(rawTitle)) {
            qualityTokens.push(item.label);
        }
    }

    const qualityText = qualityTokens.length > 0 ? qualityTokens.join(' ') : 'WEB-DL';
    score += Math.min(seeds, 40) + wrongSeasonPenalty;

    const formattedDescription = `🎞️ • ${qualityText}\n📦 • ${sizeText}`;

    return {
        resolution,
        audioLabel,
        formattedDescription,
        score
    };
}

function extractInfoHash(streamObj) {
    if (streamObj.infoHash && /^[a-fA-F0-9]{40}$/.test(streamObj.infoHash)) {
        return streamObj.infoHash.toLowerCase();
    }
    const rawText = `${streamObj.url || ''} ${streamObj.externalUrl || ''} ${JSON.stringify(streamObj.sources || [])}`;
    const match = rawText.match(/\b([a-fA-F0-9]{40})\b/);
    return match ? match[1].toLowerCase() : null;
}

// =========================================================
// CATÁLOGOS E METADADOS (SINOPSES + TEMPORADAS + EPISÓDIOS EM PT-BR)
// =========================================================

async function fetchAnimesCatalog(searchQuery = '', skip = 0) {
    try {
        const params = { 'page[limit]': 20, 'page[offset]': skip };
        if (searchQuery) params['filter[text]'] = searchQuery;
        else params['sort'] = '-userCount';

        const res = await axios.get('https://kitsu.io/api/edge/anime', { params, timeout: 7000 });
        const items = res.data?.data || [];

        const synopses = items.map(item => item.attributes?.synopsis || '');
        const translatedSynopses = await translateBatchToPtBr(synopses);

        return items.map((item, idx) => {
            const attr = item.attributes || {};
            return {
                id: `kitsu:${item.id}`,
                type: 'anime',
                name: attr.titles?.pt_br || attr.titles?.en || attr.canonicalTitle || 'Anime',
                poster: attr.posterImage?.medium || attr.posterImage?.original || '',
                background: attr.coverImage?.original || attr.posterImage?.original || '',
                description: translatedSynopses[idx] || attr.synopsis || '',
                releaseInfo: attr.startDate ? attr.startDate.split('-')[0] : ''
            };
        });
    } catch {
        return [];
    }
}

// Metadados completos de Animes com sinopses e títulos de episódios traduzidos
async function fetchAnimeMeta(kitsuId, requestedType = 'anime') {
    const cacheKey = `kitsu:${kitsuId}:${requestedType}`;
    if (metaTranslationCache.has(cacheKey)) {
        return metaTranslationCache.get(cacheKey);
    }

    try {
        const [animeRes, epRes] = await Promise.all([
            axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 6000 }),
            axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}/episodes?page[limit]=20&sort=number`, { timeout: 6000 })
        ]);

        const attr = animeRes.data?.data?.attributes || {};
        const episodes = epRes.data?.data || [];

        // Prepara lote de tradução: [sinopse principal, títulos dos episódios..., sinopses dos episódios...]
        const epTitles = episodes.map(ep => ep.attributes?.canonicalTitle || '');
        const epSynopses = episodes.map(ep => ep.attributes?.synopsis || ep.attributes?.description || '');

        const [ptMainSynopsis, ...restTranslated] = await translateBatchToPtBr([
            attr.synopsis || '',
            ...epTitles,
            ...epSynopses
        ]);

        const translatedEpTitles = restTranslated.slice(0, episodes.length);
        const translatedEpSynopses = restTranslated.slice(episodes.length);

        const videos = episodes.map((ep, idx) => {
            const epAttr = ep.attributes || {};
            const epNum = epAttr.number || (idx + 1);
            const tTitle = translatedEpTitles[idx] || `Episódio ${epNum}`;
            const tOverview = translatedEpSynopses[idx] || ptMainSynopsis;
            return {
                id: `kitsu:${kitsuId}:${epNum}`,
                title: tTitle,
                name: tTitle,
                season: 1,
                episode: epNum,
                overview: tOverview,
                description: tOverview,
                released: epAttr.airdate ? new Date(epAttr.airdate).toISOString() : new Date().toISOString(),
                thumbnail: epAttr.thumbnail?.original || attr.posterImage?.medium || ''
            };
        });

        if (videos.length === 0) {
            videos.push({
                id: `kitsu:${kitsuId}:1`,
                title: 'Episódio 1',
                name: 'Episódio 1',
                season: 1,
                episode: 1,
                overview: ptMainSynopsis,
                description: ptMainSynopsis,
                released: new Date().toISOString()
            });
        }

        const resultMeta = {
            id: `kitsu:${kitsuId}`,
            type: requestedType,
            name: attr.titles?.pt_br || attr.titles?.en || attr.canonicalTitle || 'Anime',
            poster: attr.posterImage?.large || attr.posterImage?.original || '',
            background: attr.coverImage?.original || attr.posterImage?.original || '',
            description: ptMainSynopsis,
            releaseInfo: attr.startDate ? attr.startDate.split('-')[0] : '',
            imdbRating: attr.averageRating ? (parseFloat(attr.averageRating) / 10).toFixed(1) : undefined,
            videos
        };

        if (metaTranslationCache.size > 300) metaTranslationCache.clear();
        metaTranslationCache.set(cacheKey, resultMeta);
        return resultMeta;
    } catch {
        return null;
    }
}

// Metadados completos de Filmes e Séries (IMDb) + Tradução de TODOS os Episódios das Temporadas
async function fetchImdbMeta(type, imdbId, tmdbKey = '') {
    const cleanId = imdbId.split(':')[0];
    const metaType = type === 'movie' ? 'movie' : 'series';
    const cacheKey = `${metaType}:${cleanId}:${Boolean(tmdbKey)}`;

    if (metaTranslationCache.has(cacheKey)) {
        return metaTranslationCache.get(cacheKey);
    }

    try {
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${metaType}/${cleanId}.json`, { timeout: 7500 });
        const meta = res.data?.meta;

        if (!meta) return null;

        let isTranslatedByTmdb = false;

        // 1. Se tiver TMDB Key configurada, busca título, capa e sinopse oficial PT-BR
        if (tmdbKey) {
            try {
                const findRes = await axios.get(
                    `https://api.themoviedb.org/3/find/${cleanId}`,
                    {
                        params: { api_key: tmdbKey, external_source: 'imdb_id', language: 'pt-BR' },
                        timeout: 3500
                    }
                );
                const match = metaType === 'movie'
                    ? findRes.data?.movie_results?.[0]
                    : findRes.data?.tv_results?.[0];

                if (match) {
                    meta.name = match.title || match.name || meta.name;
                    if (match.overview) {
                        meta.description = match.overview;
                        isTranslatedByTmdb = true;
                    }
                    if (match.poster_path) meta.poster = `https://image.tmdb.org/t/p/w500${match.poster_path}`;
                    if (match.backdrop_path) meta.background = `https://image.tmdb.org/t/p/original${match.backdrop_path}`;
                }
            } catch {}
        }

        // 2. Traduz a sinopse principal + TODOS os títulos e resumos de episódios (meta.videos) em lote!
        const videos = Array.isArray(meta.videos) ? meta.videos : [];
        const videoTitles = videos.map(v => v.name || v.title || '');
        const videoOverviews = videos.map(v => v.overview || v.description || '');

        const batchInput = [
            isTranslatedByTmdb ? '' : (meta.description || ''),
            ...videoTitles,
            ...videoOverviews
        ];

        const batchOutput = await translateBatchToPtBr(batchInput);

        if (!isTranslatedByTmdb && batchOutput[0]) {
            meta.description = batchOutput[0];
        }

        const translatedTitles = batchOutput.slice(1, 1 + videos.length);
        const translatedOverviews = batchOutput.slice(1 + videos.length);

        if (videos.length > 0) {
            meta.videos = videos.map((v, idx) => {
                const ptTitle = translatedTitles[idx] || v.name || v.title || `Episódio ${v.episode || idx + 1}`;
                const ptOverview = translatedOverviews[idx] || v.overview || v.description || '';
                return {
                    ...v,
                    name: ptTitle,
                    title: ptTitle,
                    overview: ptOverview,
                    description: ptOverview
                };
            });
        }

        // 3. Traduz os géneros
        if (meta.genres) meta.genres = translateGenresToPtBr(meta.genres);
        if (meta.genre) meta.genre = translateGenresToPtBr(meta.genre);

        if (metaTranslationCache.size > 300) metaTranslationCache.clear();
        metaTranslationCache.set(cacheKey, meta);
        return meta;
    } catch {
        return {
            id: cleanId,
            type: metaType,
            name: cleanId,
            poster: `https://images.metahub.space/poster/medium/${cleanId}/img`,
            background: `https://images.metahub.space/background/medium/${cleanId}/img`
        };
    }
}

async function fetchMoviesOrSeriesCatalog(type, catalogId, extraObj = {}, tmdbKey = '') {
    try {
        if (catalogId.includes('continue')) {
            const saved = recentlyWatched[type] || [];
            if (saved.length > 0) return saved;
        }

        const feedType = catalogId.includes('top') ? 'imdbRating' : 'top';

        const extraParts = [];
        if (extraObj.search) extraParts.push(`search=${encodeURIComponent(extraObj.search)}`);
        if (extraObj.genre) extraParts.push(`genre=${encodeURIComponent(extraObj.genre)}`);
        if (extraObj.skip && parseInt(extraObj.skip, 10) > 0) {
            extraParts.push(`skip=${parseInt(extraObj.skip, 10)}`);
        }

        const extraSuffix = extraParts.length > 0 ? `/${extraParts.join('&')}.json` : '.json';
        const url = `https://v3-cinemeta.strem.io/catalog/${type}/${feedType}${extraSuffix}`;

        const res = await axios.get(url, { timeout: 7500 });
        const metas = (res.data?.metas || []).slice(0, 20);

        const descriptions = metas.map(m => m.description || '');
        const translatedDescriptions = await translateBatchToPtBr(descriptions);

        return metas.map((meta, idx) => ({
            ...meta,
            description: translatedDescriptions[idx] || meta.description || '',
            genres: meta.genres ? translateGenresToPtBr(meta.genres) : undefined,
            genre: meta.genre ? translateGenresToPtBr(meta.genre) : undefined
        }));
    } catch (err) {
        console.error('Erro ao buscar catálogo:', err.message);
        return [];
    }
}

async function getMediaMetadata(type, idPrefix, rawId) {
    try {
        if (idPrefix === 'kitsu') {
            const kitsuId = rawId.split(':')[1];
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 5000 });
            const attrs = res.data?.data?.attributes;
            return {
                id: `kitsu:${kitsuId}`,
                name: attrs?.canonicalTitle || attrs?.titles?.en_jp || '',
                title: attrs?.canonicalTitle || attrs?.titles?.en_jp || '',
                poster: attrs?.posterImage?.medium || '',
                year: attrs?.startDate ? attrs.startDate.split('-')[0] : ''
            };
        } else {
            const imdbId = rawId.split(':')[0];
            const metaType = type === 'movie' ? 'movie' : 'series';
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${metaType}/${imdbId}.json`, { timeout: 5000 });
            const meta = res.data?.meta || {};
            const ptDesc = meta.description ? await translateToPtBr(meta.description) : '';
            return {
                id: imdbId,
                name: meta.name || '',
                title: meta.name || '',
                poster: meta.poster || `https://images.metahub.space/poster/medium/${imdbId}/img`,
                background: meta.background || `https://images.metahub.space/background/medium/${imdbId}/img`,
                description: ptDesc,
                releaseInfo: meta.releaseInfo || '',
                year: meta.releaseInfo?.split('–')[0] || ''
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
            .map(item => {
                const sizeMB = item.size ? `${(item.size / (1024 * 1024)).toFixed(2)} MB` : '';
                return {
                    infoHash: item.hash.toLowerCase(),
                    title: `${item.name} ${sizeMB}`,
                    fileIdx: null,
                    source: 'TorBox Cloud'
                };
            });
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
                activeIndexers.push({ name: 'Custom', url, isNativePtBr: false });
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
                    title: rawTitle,
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

// Página de Configuração
app.get(['/', '/configure', '/:config/configure'], (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <title>Stremio PT-BR Pro 3.3</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 1rem; }
            .card { background: #1e293b; padding: 2rem; border-radius: 12px; width: 100%; max-width: 500px; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
            h2 { margin-top: 0; color: #4ade80; }
            .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 1rem; }
            .badge { background: #334155; color: #38bdf8; padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: bold; }
            label { display: block; margin-top: 1rem; font-size: 0.9rem; color: #cbd5e1; font-weight: 500; }
            select, input[type="text"], input[type="password"] { width: 100%; padding: 0.75rem; margin-top: 0.4rem; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 0.95rem; }
            .torbox-box { background: #0f172a80; border: 1px solid #334155; padding: 1rem; border-radius: 8px; margin-top: 1rem; }
            .checkbox-label { display: flex; align-items: center; gap: 8px; margin-top: 0.8rem; cursor: pointer; font-size: 0.9rem; font-weight: normal; }
            .btn { display: block; text-align: center; text-decoration: none; width: 100%; margin-top: 1.2rem; padding: 0.85rem; border: none; border-radius: 8px; font-size: 1rem; font-weight: bold; cursor: pointer; box-sizing: border-box; }
            .btn-green { background: #16a34a; color: white; }
            .btn-green:hover { background: #15803d; }
            .btn-blue { background: #0284c7; color: white; margin-top: 0.6rem; }
            .btn-blue:hover { background: #0369a1; }
            .url-box { margin-top: 1rem; padding: 0.6rem; background: #0f172a; border: 1px dashed #475569; border-radius: 8px; font-size: 0.75rem; word-break: break-all; color: #94a3b8; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>🎬 Stremio PT-BR Pro 3.3</h2>
            <div class="badges">
                <span class="badge">Episódios & Sinopses PT-BR</span>
                <span class="badge">Recomendados & Continue Assistindo</span>
                <span class="badge">🧲 P2P & ⚡ TorBox</span>
            </div>
            
            <label>Como você deseja assistir?</label>
            <select id="mode" onchange="updateLinks()">
                <option value="p2p">🧲 Sem API TorBox (Modo P2P Torrent Gratuito)</option>
                <option value="torbox">⚡ Usar API do TorBox (Cache Instantâneo Debrid)</option>
                <option value="hybrid">🔀 Modo Híbrido (Mostrar links TorBox + links P2P)</option>
            </select>

            <div id="torboxSection" class="torbox-box" style="display: none;">
                <label style="margin-top: 0;">TorBox API Key:</label>
                <input type="password" id="apiKey" placeholder="Cole sua chave da conta TorBox..." oninput="updateLinks()" />
                
                <label class="checkbox-label">
                    <input type="checkbox" id="cachedOnly" checked onchange="updateLinks()" />
                    Mostrar apenas streams em cache instantâneo
                </label>
            </div>
            
            <label>TMDB API Key (Opcional - Tradução automática já ativa):</label>
            <input type="text" id="tmdbKey" placeholder="Opcional: episódios e sinopses já são traduzidos!" oninput="updateLinks()" />

            <label>Indexadores Extras Opcionais (separados por vírgula):</label>
            <input type="text" id="customIndexers" placeholder="Opcional: Torrentio, Brazuca e MediaFusion já inclusos" oninput="updateLinks()" />

            <label class="checkbox-label">
                <input type="checkbox" id="onlyDubbed" onchange="updateLinks()" />
                Apenas Dublado / Dual Áudio (Ocultar apenas legendados)
            </label>

            <a id="installAppBtn" class="btn btn-green" href="#">🚀 Abrir e Instalar no Stremio</a>
            <button type="button" class="btn btn-blue" onclick="copyManifestUrl()" id="copyBtn">📋 Copiar Link do Manifesto</button>

            <div class="url-box" id="manifestUrlDisplay"></div>
        </div>
        <script>
            let currentHttpUrl = '';

            function updateLinks() {
                const mode = document.getElementById('mode').value;
                const tbSection = document.getElementById('torboxSection');
                tbSection.style.display = (mode === 'p2p') ? 'none' : 'block';

                const apiKey = mode === 'p2p' ? '' : document.getElementById('apiKey').value.trim();
                const tmdbKey = document.getElementById('tmdbKey').value.trim();
                const indexerUrl = document.getElementById('customIndexers').value.trim();
                const onlyDubbed = document.getElementById('onlyDubbed').checked;
                const cachedOnly = document.getElementById('cachedOnly').checked;

                const config = { mode, apiKey, tmdbKey, indexerUrl, onlyDubbed, cachedOnly };
                const encoded = btoa(JSON.stringify(config))
                    .replace(/\\+/g, '-')
                    .replace(/\\//g, '_')
                    .replace(/=+$/, '');

                const host = window.location.host;
                const protocol = window.location.protocol;
                currentHttpUrl = protocol + '//' + host + '/' + encoded + '/manifest.json';
                const stremioDeepLink = 'stremio://' + host + '/' + encoded + '/manifest.json';

                document.getElementById('installAppBtn').href = stremioDeepLink;
                document.getElementById('manifestUrlDisplay').textContent = currentHttpUrl;
            }

            function copyManifestUrl() {
                navigator.clipboard.writeText(currentHttpUrl).then(() => {
                    const btn = document.getElementById('copyBtn');
                    btn.textContent = '✅ Link Copiado!';
                    setTimeout(() => {
                        btn.textContent = '📋 Copiar Link do Manifesto';
                    }, 3000);
                });
            }

            updateLinks();
        </script>
    </body>
    </html>
    `);
});

app.get(['/manifest.json', '/:config/manifest.json', '/*/manifest.json'], (req, res) => {
    const parts = req.path.split('/').filter(Boolean);
    const configSeg = parts.length > 1 ? parts[parts.length - 2] : (req.query.config || '');
    const config = decodeConfig(configSeg);
    res.json(buildManifest(config));
});

// Rota de Catálogo
async function handleCatalogRequest(req, res) {
    const { config: configStr, type, id: catalogId, extra } = req.params;
    const config = decodeConfig(configStr);

    const extraObj = {};
    if (extra) {
        const pairs = extra.split('&');
        for (const pair of pairs) {
            const [k, v] = pair.split('=');
            if (k && v !== undefined) {
                extraObj[k] = decodeURIComponent(v);
            }
        }
    }

    if (type === 'anime' || catalogId.includes('anime')) {
        const metas = await fetchAnimesCatalog(extraObj.search || '', parseInt(extraObj.skip || '0', 10));
        return res.json({ metas });
    }

    const metas = await fetchMoviesOrSeriesCatalog(type, catalogId, extraObj, config.tmdbKey);
    res.json({ metas });
}

app.get([
    '/catalog/:type/:id.json',
    '/catalog/:type/:id/:extra.json',
    '/:config/catalog/:type/:id.json',
    '/:config/catalog/:type/:id/:extra.json'
], handleCatalogRequest);

// Rota Completa de Metadados (Traduz Sinopse Principal + Todos os Episódios em Lote)
async function handleMetaRequest(req, res) {
    const { config: configStr, type } = req.params;
    const rawId = decodeURIComponent(req.params.id || '');
    const config = decodeConfig(configStr);

    if (rawId.startsWith('kitsu:')) {
        const kitsuId = rawId.split(':')[1];
        const meta = await fetchAnimeMeta(kitsuId, type);
        return res.json({ meta });
    }

    if (rawId.startsWith('tt')) {
        const meta = await fetchImdbMeta(type, rawId, config.tmdbKey);
        if (meta && meta.name) {
            addToContinueWatching(type, meta);
        }
        return res.json({ meta });
    }

    res.json({ meta: null });
}

app.get([
    '/meta/:type/:id.json',
    '/:config/meta/:type/:id.json'
], handleMetaRequest);

// Rota de Streams
async function handleStreamRequest(req, res) {
    const { config: configStr, type } = req.params;
    const id = decodeURIComponent(req.params.id || '');
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

    if (idPrefix === 'tt' && metadata.name) {
        addToContinueWatching(type, metadata);
    }

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

    // 1. TorBox: ⚡ • 1080p - Dublado
    if ((mode === 'torbox' || mode === 'hybrid') && activeApiKey) {
        const hashes = candidates.map(c => c.infoHash);
        const cachedMap = await checkTorBoxCache(activeApiKey, hashes);

        for (const item of candidates) {
            const isCached = Boolean(cachedMap[item.infoHash]);
            if (config.cachedOnly && !isCached) continue;

            const info = parseAndFormatStream(item.title, season);
            const cacheBonus = isCached ? 2000 : 1000;
            const totalScore = cacheBonus + info.score;

            const resolveUrl = `${host}/${configStr || 'p2p'}/resolve/${item.infoHash}/${season ?? 0}/${episode ?? 0}`;

            scoredStreams.push({
                name: `⚡ • ${info.resolution} - ${info.audioLabel}`,
                title: info.formattedDescription,
                url: resolveUrl,
                behaviorHints: {
                    bingeGroup: `torbox-ptbr-${info.resolution}-${isCached ? 'cached' : 'uncached'}`
                },
                _score: totalScore
            });
        }
    }

    // 2. P2P: 🧲 • 1080p - Dublado
    if (mode === 'p2p' || mode === 'hybrid' || !activeApiKey) {
        for (const c of candidates) {
            const info = parseAndFormatStream(c.title, season);

            scoredStreams.push({
                name: `🧲 • ${info.resolution} - ${info.audioLabel}`,
                title: info.formattedDescription,
                infoHash: c.infoHash,
                ...(c.fileIdx !== null && c.fileIdx !== undefined ? { fileIdx: c.fileIdx } : {}),
                sources: PUBLIC_TRACKERS,
                behaviorHints: {
                    bingeGroup: `p2p-ptbr-${info.resolution}`
                },
                _score: info.score
            });
        }
    }

    scoredStreams.sort((a, b) => b._score - a._score);

    const finalStreams = scoredStreams.map(({ _score, ...stream }) => stream);
    res.json({ streams: finalStreams });
}

app.get([
    '/stream/:type/:id.json',
    '/:config/stream/:type/:id.json'
], handleStreamRequest);

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
