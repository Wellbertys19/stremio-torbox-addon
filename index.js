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
const TORBOX_SEARCH_API = 'https://search-api.torbox.app';

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

            for (let j = 0; j < chunk.texts.length; j++) {
                results[chunk.indices[j]] = chunk.texts[j];
            }
        })
    );

    return results;
}

// =========================================================
// HISTÓRICO "CONTINUE ASSISTINDO" E INDEXADORES
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
    },
    {
        name: 'Comet',
        url: 'https://comet.elfhosted.com',
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
    if (!configStr || configStr === 'configure') return { mode: 'torbox' };
    try {
        const b64 = configStr.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } catch {
        return { mode: 'torbox' };
    }
}

function buildManifest(config = {}) {
    return {
        id: 'org.community.torbox.ptbr.pro',
        version: '4.0.0',
        name: config.apiKey ? 'TorBox PT-BR All-In-One' : 'TorBox PT-BR (Configurar API)',
        description: 'Todos os meios TorBox (Torrents Cache, Usenet Pro, WebDL e Nuvem Pessoal) + Catálogos e Episódios em PT-BR (P2P Desativado).',
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
// FORMATADOR E CLASSIFICADOR POR QUALIDADE E TAMANHO
// =========================================================

function formatBytesToSizeText(bytes) {
    if (!bytes || isNaN(bytes) || bytes <= 0) return null;
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) {
        return `${(mb / 1024).toFixed(2)} GB`;
    }
    return `${mb.toFixed(2)} MB`;
}

function parseAndFormatStream(rawTitle = '', season = null, explicitBytes = 0) {
    const sizeMatch = rawTitle.match(/(?:💾\s*)?(\d+(?:[.,]\d+)?)\s*(GB|MB|GiB|MiB)/i);
    let sizeText = 'Tamanho N/D';
    let sizeInMB = 0;

    if (explicitBytes && explicitBytes > 0) {
        sizeInMB = explicitBytes / (1024 * 1024);
        sizeText = formatBytesToSizeText(explicitBytes) || 'Tamanho N/D';
    } else if (sizeMatch) {
        const rawValue = parseFloat(sizeMatch[1].replace(',', '.'));
        const rawUnit = sizeMatch[2].toUpperCase().replace('GIB', 'GB').replace('MIB', 'MB');
        sizeText = `${rawValue} ${rawUnit}`;
        sizeInMB = rawUnit === 'GB' ? rawValue * 1024 : rawValue;
    }

    let isRightSeason = 1;
    const firstLine = rawTitle.split('\n')[0] || '';
    if (season !== null) {
        const seasonMention = firstLine.match(/(\d+)\s*[ªa°]?\s*temporada|\bs0?(\d+)\b/i);
        if (seasonMention) {
            const foundSeason = parseInt(seasonMention[1] || seasonMention[2], 10);
            if (foundSeason !== season && !/todas\s*temporada|completa/i.test(firstLine)) {
                isRightSeason = 0;
            }
        }
    }

    let resolution = 'HD';
    let resolutionRank = 2;
    if (/\b(2160p|4k|uhd)\b/i.test(rawTitle)) {
        resolution = '4K';
        resolutionRank = 5;
    } else if (/\b(1080p|fhd|full\s*hd)\b/i.test(rawTitle)) {
        resolution = '1080p';
        resolutionRank = 4;
    } else if (/\b(720p|hd)\b/i.test(rawTitle)) {
        resolution = '720p';
        resolutionRank = 3;
    } else if (/\b(480p|360p)\b/i.test(rawTitle)) {
        resolution = '480p';
        resolutionRank = 1;
    }

    let sourceQualityRank = 30;
    if (/\bremux\b/i.test(rawTitle)) {
        sourceQualityRank = 60;
    } else if (/\bblu-?ray\b/i.test(rawTitle) && !/\b(bdrip|brrip)\b/i.test(rawTitle)) {
        sourceQualityRank = 50;
    } else if (/\b(bdrip|brrip)\b/i.test(rawTitle)) {
        sourceQualityRank = 40;
    } else if (/\bweb-?dl\b/i.test(rawTitle)) {
        sourceQualityRank = 30;
    } else if (/\bwebrip\b/i.test(rawTitle)) {
        sourceQualityRank = 20;
    } else if (/\b(hdtv|dvdrip)\b/i.test(rawTitle)) {
        sourceQualityRank = 10;
    }

    if (/\b(hdr|hdr10|dv|dolby\s*vision)\b/i.test(rawTitle)) sourceQualityRank += 5;
    if (/\b(hevc|x265|10bit)\b/i.test(rawTitle)) sourceQualityRank += 2;

    const isDubOrDual = /(\bdublado\b|\bdub\b|\bdual[-_. ]?audio\b|\bdual\b|\bnacional\b)/i.test(rawTitle);
    const audioLabel = isDubOrDual ? 'Dublado' : 'Legendado';
    const audioRank = isDubOrDual ? 2 : 1;

    const qualityTokens = [];
    const tokenMap = [
        { regex: /\bremux\b/i, label: 'Remux' },
        { regex: /\bbdrip\b/i, label: 'BDRip' },
        { regex: /\bbrrip\b/i, label: 'BRRip' },
        { regex: /\bblu-?ray\b/i, label: 'BluRay' },
        { regex: /\bweb-?dl\b/i, label: 'WEB-DL' },
        { regex: /\bwebrip\b/i, label: 'WEBRip' },
        { regex: /\bhdtv\b/i, label: 'HDTV' },
        { regex: /\bdvdrip\b/i, label: 'DVDRip' },
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
    const formattedDescription = `🎞️ • ${qualityText}\n📦 • ${sizeText}`;

    return {
        resolution,
        audioLabel,
        formattedDescription,
        isRightSeason,
        resolutionRank,
        sourceQualityRank,
        audioRank,
        sizeInMB
    };
}

function compareStreamsByQualityAndSize(a, b) {
    if (b._sort.cacheRank !== a._sort.cacheRank) {
        return b._sort.cacheRank - a._sort.cacheRank;
    }
    if (b._sort.isRightSeason !== a._sort.isRightSeason) {
        return b._sort.isRightSeason - a._sort.isRightSeason;
    }
    if (b._sort.resolutionRank !== a._sort.resolutionRank) {
        return b._sort.resolutionRank - a._sort.resolutionRank;
    }
    if (b._sort.sourceQualityRank !== a._sort.sourceQualityRank) {
        return b._sort.sourceQualityRank - a._sort.sourceQualityRank;
    }
    if (b._sort.sizeInMB !== a._sort.sizeInMB) {
        return b._sort.sizeInMB - a._sort.sizeInMB;
    }
    return b._sort.audioRank - a._sort.audioRank;
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

async function fetchMoviesOrSeriesCatalog(type, catalogId, extraObj = {}) {
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
    } catch {
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

// =========================================================
// TODOS OS MEIOS DE ASSISTIR (TORBOX TORRENTS, USENET, WEBDL & HTTP)
// =========================================================

async function checkTorBoxTorrentCache(apiKey, hashes) {
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

async function checkTorBoxUsenetCache(apiKey, hashes) {
    if (!apiKey || !hashes.length) return {};
    try {
        const batch = hashes.slice(0, 100).join(',');
        const res = await axios.get(`${TORBOX_API}/usenet/checkcached`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            params: { hash: batch, format: 'object', list_files: true },
            timeout: 8000
        });
        return res.data?.data || {};
    } catch {
        return {};
    }
}

// 1. Busca em TODAS as Nuvens Pessoais do usuário no TorBox (Torrents + Usenet + WebDL)
async function searchAllUserTorBoxClouds(apiKey, queryTitle, onlyDubbed) {
    if (!apiKey || !queryTitle) return [];
    const normalizedQuery = queryTitle.toLowerCase();
    const headers = { Authorization: `Bearer ${apiKey}` };

    const [torrentsRes, usenetRes, webdlRes] = await Promise.allSettled([
        axios.get(`${TORBOX_API}/torrents/mylist`, { headers, params: { bypass_cache: false }, timeout: 6500 }),
        axios.get(`${TORBOX_API}/usenet/mylist`, { headers, params: { bypass_cache: false }, timeout: 6500 }),
        axios.get(`${TORBOX_API}/webdl/mylist`, { headers, params: { bypass_cache: false }, timeout: 6500 })
    ]);

    const cloudStreams = [];

    const processList = (resObj, cloudType) => {
        if (resObj.status !== 'fulfilled') return;
        const list = resObj.value.data?.data || [];
        for (const item of list) {
            if (!item.download_present || !item.name) continue;
            const matchesTitle = item.name.toLowerCase().includes(normalizedQuery);
            if (matchesTitle && isPtBrStream(item.name, onlyDubbed, true)) {
                cloudStreams.push({
                    kind: 'cloud',
                    cloudType, // 'torrents', 'usenet', 'webdl'
                    itemId: item.id,
                    title: item.name,
                    sizeBytes: item.size || 0
                });
            }
        }
    };

    processList(torrentsRes, 'torrents');
    processList(usenetRes, 'usenet');
    processList(webdlRes, 'webdl');

    return cloudStreams;
}

// 2. Busca na API Oficial de Pesquisa do TorBox (Torrents + Usenet Pro)
async function searchTorBoxOfficialApi(apiKey, rawId, season, episode, onlyDubbed) {
    if (!apiKey) return { torrents: [], usenet: [] };

    const baseImdb = rawId.split(':')[0];
    if (!baseImdb.startsWith('tt')) return { torrents: [], usenet: [] };

    const params = {};
    if (season !== null) params.season = season;
    if (episode !== null) params.episode = episode;

    const headers = { Authorization: `Bearer ${apiKey}` };

    const [torRes, useRes] = await Promise.allSettled([
        axios.get(`${TORBOX_SEARCH_API}/torrents/imdb:${baseImdb}`, { headers, params, timeout: 6500 }),
        axios.get(`${TORBOX_SEARCH_API}/usenet/imdb:${baseImdb}`, { headers, params, timeout: 6500 })
    ]);

    const torrents = [];
    const usenet = [];

    if (torRes.status === 'fulfilled') {
        const items = torRes.value.data?.data?.torrents || [];
        for (const t of items) {
            const rawTitle = t.raw_title || t.title || '';
            if (t.hash && isPtBrStream(rawTitle, onlyDubbed, false)) {
                torrents.push({
                    infoHash: t.hash.toLowerCase(),
                    title: rawTitle,
                    sizeBytes: t.size || 0,
                    cached: Boolean(t.cached)
                });
            }
        }
    }

    if (useRes.status === 'fulfilled') {
        const items = useRes.value.data?.data?.nzbs || [];
        for (const u of items) {
            const rawTitle = u.raw_title || u.title || '';
            if (u.nzb && isPtBrStream(rawTitle, onlyDubbed, false)) {
                usenet.push({
                    hash: (u.hash || '').toLowerCase(),
                    nzbUrl: u.nzb,
                    title: rawTitle,
                    sizeBytes: u.size || 0,
                    cached: Boolean(u.cached)
                });
            }
        }
    }

    return { torrents, usenet };
}

// 3. Busca em todos os Indexadores Externos (Torrentio, Brazuca, MediaFusion, Comet + Custom)
async function fetchExternalSources(type, id, customIndexerUrls, onlyDubbed) {
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
    const torrentCandidates = [];
    const directHttpStreams = [];

    for (const r of responses) {
        if (r.status !== 'fulfilled') continue;
        const { indexer, streams } = r.value;

        for (const s of streams) {
            const fullText = `${s.name || ''} ${s.title || ''} ${s.description || ''}`;
            if (!isPtBrStream(fullText, onlyDubbed, indexer.isNativePtBr)) continue;

            const rawTitle = s.title || s.description || s.name || 'Stream PT-BR';
            const hash = extractInfoHash(s);

            if (hash) {
                torrentCandidates.push({
                    infoHash: hash,
                    title: rawTitle,
                    sizeBytes: 0,
                    source: indexer.name
                });
            } else if (s.url && /^https?:\/\//i.test(s.url)) {
                // Stream HTTP direto já resolvido pelo provedor
                directHttpStreams.push({
                    directUrl: s.url,
                    title: rawTitle,
                    source: indexer.name
                });
            }
        }
    }

    return { torrentCandidates, directHttpStreams };
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

// =========================================================
// PÁGINA DE CONFIGURAÇÃO (P2P DESATIVADO)
// =========================================================

app.get(['/', '/configure', '/:config/configure'], (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <title>TorBox PT-BR All-In-One 4.0</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 1rem; }
            .card { background: #1e293b; padding: 2rem; border-radius: 12px; width: 100%; max-width: 520px; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
            h2 { margin-top: 0; color: #4ade80; }
            .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 1rem; }
            .badge { background: #334155; color: #38bdf8; padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: bold; }
            .badge-off { background: #450a0a; color: #fca5a5; }
            label { display: block; margin-top: 1rem; font-size: 0.9rem; color: #cbd5e1; font-weight: 500; }
            input[type="text"], input[type="password"] { width: 100%; padding: 0.75rem; margin-top: 0.4rem; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 0.95rem; }
            .methods-box { background: #0f172a80; border: 1px solid #334155; padding: 1rem; border-radius: 8px; margin-top: 1rem; }
            .checkbox-label { display: flex; align-items: center; gap: 8px; margin-top: 0.65rem; cursor: pointer; font-size: 0.9rem; font-weight: normal; }
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
            <h2>⚡ TorBox PT-BR All-In-One 4.0</h2>
            <div class="badges">
                <span class="badge">TorBox Torrents</span>
                <span class="badge">TorBox Usenet (Pro)</span>
                <span class="badge">TorBox WebDL & Nuvem</span>
                <span class="badge">Streams HTTP Diretos</span>
                <span class="badge badge-off">P2P Desativado</span>
            </div>
            
            <label>TorBox API Key (Obrigatório para Torrents, Usenet e Nuvem):</label>
            <input type="password" id="apiKey" placeholder="Cole sua chave da conta TorBox..." oninput="updateLinks()" />

            <div class="methods-box">
                <label style="margin-top: 0; color: #38bdf8;">Meios de Reprodução Ativos:</label>
                <label class="checkbox-label">
                    <input type="checkbox" id="enableTorrents" checked onchange="updateLinks()" />
                    ⚡ TorBox Torrents (Torrentio, Brazuca, MediaFusion, Comet & TorBox Search)
                </label>
                <label class="checkbox-label">
                    <input type="checkbox" id="enableUsenet" checked onchange="updateLinks()" />
                    ⚡ TorBox Usenet (Busca NZB Instantânea & Nuvem Usenet Pro)
                </label>
                <label class="checkbox-label">
                    <input type="checkbox" id="enableCloud" checked onchange="updateLinks()" />
                    ⚡ TorBox Nuvem Pessoal & WebDL (Arquivos salvos na sua conta)
                </label>
                <label class="checkbox-label">
                    <input type="checkbox" id="enableHttp" checked onchange="updateLinks()" />
                    ⚡ Streams HTTP Diretos (Links HTTPS nativos dos indexadores)
                </label>
            </div>

            <label class="checkbox-label" style="margin-top: 1rem;">
                <input type="checkbox" id="cachedOnly" checked onchange="updateLinks()" />
                Mostrar apenas streams em cache instantâneo no TorBox
            </label>

            <label class="checkbox-label">
                <input type="checkbox" id="onlyDubbed" onchange="updateLinks()" />
                Apenas Dublado / Dual Áudio (Ocultar apenas legendados)
            </label>
            
            <label>Indexadores Extras Opcionais (separados por vírgula):</label>
            <input type="text" id="customIndexers" placeholder="Opcional: Torrentio, Brazuca, MediaFusion e Comet já inclusos" oninput="updateLinks()" />

            <button type="button" class="btn btn-blue" onclick="copyManifestUrl()" id="copyBtn">📋 Copiar Link do Manifesto (Multidispositivo)</button>
            <a id="installAppBtn" class="btn btn-green" href="#">🚀 Abrir e Instalar no App</a>

            <div class="url-box" id="manifestUrlDisplay"></div>
        </div>
        <script>
            let currentHttpUrl = '';

            function updateLinks() {
                const apiKey = document.getElementById('apiKey').value.trim();
                const indexerUrl = document.getElementById('customIndexers').value.trim();
                const onlyDubbed = document.getElementById('onlyDubbed').checked;
                const cachedOnly = document.getElementById('cachedOnly').checked;
                const enableTorrents = document.getElementById('enableTorrents').checked;
                const enableUsenet = document.getElementById('enableUsenet').checked;
                const enableCloud = document.getElementById('enableCloud').checked;
                const enableHttp = document.getElementById('enableHttp').checked;

                const config = {
                    mode: 'torbox',
                    apiKey,
                    indexerUrl,
                    onlyDubbed,
                    cachedOnly,
                    enableTorrents,
                    enableUsenet,
                    enableCloud,
                    enableHttp
                };

                const encoded = btoa(JSON.stringify(config))
                    .replace(/\\+/g, '-')
                    .replace(/\\//g, '_')
                    .replace(/=+$/, '');

                const host = window.location.host;
                const protocol = window.location.protocol;
                currentHttpUrl = protocol + '//' + host + '/' + encoded + '/manifest.json';
                const appDeepLink = 'stremio://' + host + '/' + encoded + '/manifest.json';

                document.getElementById('installAppBtn').href = appDeepLink;
                document.getElementById('manifestUrlDisplay').textContent = currentHttpUrl;
            }

            function copyManifestUrl() {
                navigator.clipboard.writeText(currentHttpUrl).then(() => {
                    const btn = document.getElementById('copyBtn');
                    btn.textContent = '✅ Link Copiado!';
                    setTimeout(() => {
                        btn.textContent = '📋 Copiar Link do Manifesto (Multidispositivo)';
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
    const { type, id: catalogId, extra } = req.params;

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

    const metas = await fetchMoviesOrSeriesCatalog(type, catalogId, extraObj);
    res.json({ metas });
}

app.get([
    '/catalog/:type/:id.json',
    '/catalog/:type/:id/:extra.json',
    '/:config/catalog/:type/:id.json',
    '/:config/catalog/:type/:id/:extra.json'
], handleCatalogRequest);

// Rota Completa de Metadados
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

// =========================================================
// ROTA DE STREAMS (TODOS OS MEIOS ATIVOS • SEM P2P)
// =========================================================

async function handleStreamRequest(req, res) {
    const { config: configStr, type } = req.params;
    const id = decodeURIComponent(req.params.id || '');
    const config = decodeConfig(configStr);

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

    const apiKey = (config.apiKey || '').trim();
    const onlyDubbed = Boolean(config.onlyDubbed);
    const cachedOnly = config.cachedOnly !== false;

    const enableTorrents = config.enableTorrents !== false;
    const enableUsenet = config.enableUsenet !== false;
    const enableCloud = config.enableCloud !== false;
    const enableHttp = config.enableHttp !== false;

    // Executa todas as buscas em paralelo (Nuvem TorBox, Busca Oficial TorBox, Indexadores Externos)
    const [cloudItems, tbSearch, externalData] = await Promise.all([
        (apiKey && enableCloud && metadata.title)
            ? searchAllUserTorBoxClouds(apiKey, metadata.title, onlyDubbed)
            : Promise.resolve([]),
        (apiKey && (enableTorrents || enableUsenet))
            ? searchTorBoxOfficialApi(apiKey, id, season, episode, onlyDubbed)
            : Promise.resolve({ torrents: [], usenet: [] }),
        (enableTorrents || enableHttp)
            ? fetchExternalSources(type, id, config.indexerUrl, onlyDubbed)
            : Promise.resolve({ torrentCandidates: [], directHttpStreams: [] })
    ]);

    const scoredStreams = [];

    // MEIO 1: Nuvem Pessoal do Usuário no TorBox (Torrents, Usenet e WebDL já baixados)
    if (apiKey && enableCloud && cloudItems.length > 0) {
        for (const item of cloudItems) {
            const info = parseAndFormatStream(item.title, season, item.sizeBytes);
            const resolveUrl = `${host}/${configStr}/resolve/cloud/${item.cloudType}/${item.itemId}/${season ?? 0}/${episode ?? 0}`;

            scoredStreams.push({
                name: `⚡ • ${info.resolution} - ${info.audioLabel}`,
                title: info.formattedDescription,
                url: resolveUrl,
                behaviorHints: {
                    bingeGroup: `torbox-cloud-${info.resolution}`
                },
                _sort: {
                    cacheRank: 3, // Prioridade máxima para arquivos já na conta do usuário
                    isRightSeason: info.isRightSeason,
                    resolutionRank: info.resolutionRank,
                    sourceQualityRank: info.sourceQualityRank,
                    sizeInMB: info.sizeInMB,
                    audioRank: info.audioRank
                }
            });
        }
    }

    // MEIO 2: TorBox Torrents (Indexadores Externos + TorBox Search API)
    if (apiKey && enableTorrents) {
        const mergedTorrentsMap = new Map();
        for (const t of [...tbSearch.torrents, ...externalData.torrentCandidates]) {
            if (t.infoHash && !mergedTorrentsMap.has(t.infoHash)) {
                mergedTorrentsMap.set(t.infoHash, t);
            }
        }
        const allTorrents = Array.from(mergedTorrentsMap.values());
        const hashes = allTorrents.map(t => t.infoHash);
        const cachedMap = await checkTorBoxTorrentCache(apiKey, hashes);

        for (const item of allTorrents) {
            const isCached = Boolean(item.cached || cachedMap[item.infoHash]);
            if (cachedOnly && !isCached) continue;

            const info = parseAndFormatStream(item.title, season, item.sizeBytes);
            const resolveUrl = `${host}/${configStr}/resolve/torrent/${item.infoHash}/${season ?? 0}/${episode ?? 0}`;

            scoredStreams.push({
                name: `⚡ • ${info.resolution} - ${info.audioLabel}`,
                title: info.formattedDescription,
                url: resolveUrl,
                behaviorHints: {
                    bingeGroup: `torbox-torrent-${info.resolution}-${isCached ? 'cached' : 'uncached'}`
                },
                _sort: {
                    cacheRank: isCached ? 2 : 1,
                    isRightSeason: info.isRightSeason,
                    resolutionRank: info.resolutionRank,
                    sourceQualityRank: info.sourceQualityRank,
                    sizeInMB: info.sizeInMB,
                    audioRank: info.audioRank
                }
            });
        }
    }

    // MEIO 3: TorBox Usenet Pro (NZB Instantâneo)
    if (apiKey && enableUsenet && tbSearch.usenet.length > 0) {
        const usenetHashes = tbSearch.usenet.map(u => u.hash).filter(Boolean);
        const usenetCacheMap = await checkTorBoxUsenetCache(apiKey, usenetHashes);

        for (const uItem of tbSearch.usenet) {
            const isCached = Boolean(uItem.cached || (uItem.hash && usenetCacheMap[uItem.hash]));
            if (cachedOnly && !isCached) continue;

            const info = parseAndFormatStream(uItem.title, season, uItem.sizeBytes);
            const encodedNzb = Buffer.from(uItem.nzbUrl, 'utf8').toString('base64url');
            const resolveUrl = `${host}/${configStr}/resolve/usenet/${encodedNzb}/${season ?? 0}/${episode ?? 0}`;

            scoredStreams.push({
                name: `⚡ • ${info.resolution} - ${info.audioLabel}`,
                title: info.formattedDescription,
                url: resolveUrl,
                behaviorHints: {
                    bingeGroup: `torbox-usenet-${info.resolution}`
                },
                _sort: {
                    cacheRank: isCached ? 2 : 1,
                    isRightSeason: info.isRightSeason,
                    resolutionRank: info.resolutionRank,
                    sourceQualityRank: info.sourceQualityRank,
                    sizeInMB: info.sizeInMB,
                    audioRank: info.audioRank
                }
            });
        }
    }

    // MEIO 4: Streams HTTP Diretos de Provedores Externos (Sem P2P)
    if (enableHttp && externalData.directHttpStreams.length > 0) {
        for (const d of externalData.directHttpStreams) {
            const info = parseAndFormatStream(d.title, season, 0);

            scoredStreams.push({
                name: `⚡ • ${info.resolution} - ${info.audioLabel}`,
                title: info.formattedDescription,
                url: d.directUrl,
                behaviorHints: {
                    bingeGroup: `direct-http-${info.resolution}`
                },
                _sort: {
                    cacheRank: 2,
                    isRightSeason: info.isRightSeason,
                    resolutionRank: info.resolutionRank,
                    sourceQualityRank: info.sourceQualityRank,
                    sizeInMB: info.sizeInMB,
                    audioRank: info.audioRank
                }
            });
        }
    }

    // Ordena rigorosamente por Qualidade (4K -> 1080p -> 720p, BluRay -> WEB-DL) e Tamanho (Maior -> Menor)
    scoredStreams.sort(compareStreamsByQualityAndSize);

    const finalStreams = scoredStreams.map(({ _sort, ...stream }) => stream);
    res.json({ streams: finalStreams });
}

app.get([
    '/stream/:type/:id.json',
    '/:config/stream/:type/:id.json'
], handleStreamRequest);

// =========================================================
// RESOLVEDORES ON-DEMAND (TORRENTS, USENET E NUVEM/WEBDL)
// =========================================================

// 1. Resolvedor de Torrents (Magnet/InfoHash -> Link Direto TorBox)
app.get([
    '/:config/resolve/torrent/:infoHash/:season/:episode',
    '/:config/resolve/:infoHash/:season/:episode'
], async (req, res) => {
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
        res.status(500).send('Erro ao resolver torrent junto à API do TorBox.');
    }
});

// 2. Resolvedor de Usenet (NZB -> Link Direto TorBox)
app.get('/:config/resolve/usenet/:encodedNzb/:season/:episode', async (req, res) => {
    const { config: configStr, encodedNzb, season, episode } = req.params;
    const config = decodeConfig(configStr);

    if (!config.apiKey) {
        return res.status(400).send('API Key do TorBox não configurada.');
    }

    try {
        const nzbUrl = Buffer.from(encodedNzb, 'base64url').toString('utf8');
        const form = new FormData();
        form.append('link', nzbUrl);

        const createRes = await axios.post(`${TORBOX_API}/usenet/createusenetdownload`, form, {
            headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${config.apiKey}`
            },
            timeout: 15000
        });

        const usenetId = createRes.data?.data?.usenetdownload_id;
        if (!usenetId) {
            return res.status(404).send('Não foi possível criar o download Usenet no TorBox.');
        }

        const listRes = await axios.get(`${TORBOX_API}/usenet/mylist`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
            params: { id: usenetId, bypass_cache: true },
            timeout: 10000
        });

        const usenetData = listRes.data?.data;
        const files = usenetData?.files || [];

        const sNum = parseInt(season, 10) > 0 ? parseInt(season, 10) : null;
        const eNum = parseInt(episode, 10) > 0 ? parseInt(episode, 10) : null;

        const targetFile = selectBestVideoFile(files, sNum, eNum);
        if (!targetFile) {
            return res.status(404).send('Nenhum arquivo de vídeo compatível encontrado na Usenet.');
        }

        const redirectDlUrl = `${TORBOX_API}/usenet/requestdl?token=${encodeURIComponent(config.apiKey)}&usenet_id=${usenetId}&file_id=${targetFile.id}&redirect=true`;
        return res.redirect(302, redirectDlUrl);
    } catch {
        res.status(500).send('Erro ao resolver Usenet junto à API do TorBox.');
    }
});

// 3. Resolvedor de Nuvem Pessoal (Torrents, Usenet e WebDL salvos na conta)
app.get('/:config/resolve/cloud/:cloudType/:itemId/:season/:episode', async (req, res) => {
    const { config: configStr, cloudType, itemId, season, episode } = req.params;
    const config = decodeConfig(configStr);

    if (!config.apiKey) {
        return res.status(400).send('API Key do TorBox não configurada.');
    }

    try {
        const endpointMap = {
            torrents: { list: 'torrents/mylist', dl: 'torrents/requestdl', idParam: 'torrent_id' },
            usenet: { list: 'usenet/mylist', dl: 'usenet/requestdl', idParam: 'usenet_id' },
            webdl: { list: 'webdl/mylist', dl: 'webdl/requestdl', idParam: 'web_id' }
        };

        const target = endpointMap[cloudType];
        if (!target) return res.status(400).send('Tipo de nuvem inválido.');

        const listRes = await axios.get(`${TORBOX_API}/${target.list}`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
            params: { id: itemId, bypass_cache: true },
            timeout: 10000
        });

        const itemData = listRes.data?.data;
        const files = itemData?.files || [];

        const sNum = parseInt(season, 10) > 0 ? parseInt(season, 10) : null;
        const eNum = parseInt(episode, 10) > 0 ? parseInt(episode, 10) : null;

        const targetFile = selectBestVideoFile(files, sNum, eNum);
        if (!targetFile) {
            return res.status(404).send('Nenhum arquivo de vídeo encontrado na nuvem.');
        }

        const redirectDlUrl = `${TORBOX_API}/${target.dl}?token=${encodeURIComponent(config.apiKey)}&${target.idParam}=${itemId}&file_id=${targetFile.id}&redirect=true`;
        return res.redirect(302, redirectDlUrl);
    } catch {
        res.status(500).send('Erro ao resolver arquivo da nuvem TorBox.');
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
}

module.exports = app;
