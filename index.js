const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 7000;
const TORBOX_API = 'https://api.torbox.app/v1/api';

// URL padrão já pré-configurada com trackers brasileiros e filtro de idioma Português
const DEFAULT_PTBR_INDEXER = 'https://torrentio.strem.fun/providers=comando,bludv,lapumia,micoleaodublado,nyaasi,tokyotosho|language=portuguese';

function decodeConfig(configStr) {
    try {
        return JSON.parse(Buffer.from(configStr, 'base64url').toString('utf8'));
    } catch {
        return {};
    }
}

function buildManifest(hasApiKey = false) {
    return {
        id: 'org.community.torbox.ptbr',
        version: '1.1.0',
        name: hasApiKey ? 'TorBox PT-BR 🇧🇷' : 'TorBox PT-BR (Configurar)',
        description: 'Filmes, Séries e Animes exclusivamente em Português (PT-BR) via TorBox API.',
        resources: ['stream'],
        types: ['movie', 'series', 'anime'],
        idPrefixes: ['tt', 'kitsu'],
        catalogs: [],
        behaviorHints: {
            configurable: true,
            configurationRequired: !hasApiKey
        }
    };
}

// Verifica se o título/descrição do torrent possui indicadores de Português (PT-BR)
function isPtBrStream(text, onlyDubbed = false) {
    if (!text) return false;

    if (onlyDubbed) {
        // Exige estritamente Dublado, Dual Áudio ou Áudio Nacional
        const dubRegex = /(🇧🇷|\bdublado\b|\bdub\b|\bdual[-_. ]?audio\b|\bdual\b|\bnacional\b|\baudio\s*pt\b|\bpt[-_. ]?br\s*dub\b)/i;
        return dubRegex.test(text);
    }

    // Aceita Dublado, Dual Áudio, PT-BR ou Legendado em Português
    const ptbrRegex = /(🇧🇷|\bpt[-_. ]?br\b|\bportugues(e)?\b|\bportuguês\b|\bdublado\b|\bdub\b|\bdual[-_. ]?audio\b|\bdual\b|\bnacional\b|\blegendado\b|\bleg\s*pt\b|\bbrazil(ian)?\b)/i;
    return ptbrRegex.test(text);
}

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
        const hashList = hashes.join(',');
        const res = await axios.get(`${TORBOX_API}/torrents/checkcached`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            params: { hash: hashList, format: 'object', list_files: true },
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
            timeout: 8000
        });
        const list = res.data?.data || [];
        const normalizedQuery = queryTitle.toLowerCase();
        return list
            .filter(item => {
                const matchesTitle = item.download_present && item.name.toLowerCase().includes(normalizedQuery);
                return matchesTitle && isPtBrStream(item.name, onlyDubbed);
            })
            .map(item => ({
                infoHash: item.hash.toLowerCase(),
                title: `🇧🇷 ${item.name}`,
                size: item.size,
                source: 'TorBox Cloud'
            }));
    } catch {
        return [];
    }
}

async function fetchCandidateTorrents(type, id, customIndexerUrl, apiKey, metadata, onlyDubbed) {
    const results = [];

    // 1. Busca na nuvem pessoal do TorBox (filtrando por PT-BR)
    if (metadata.title) {
        const cloudItems = await searchUserTorBoxCloud(apiKey, metadata.title, onlyDubbed);
        results.push(...cloudItems);
    }

    // 2. Consulta o indexador com filtro de provedores brasileiros
    const baseUrl = (customIndexerUrl || DEFAULT_PTBR_INDEXER).replace(/\/$/, '');
    try {
        const url = `${baseUrl}/stream/${type}/${encodeURIComponent(id)}.json`;
        const res = await axios.get(url, { timeout: 8000 });
        const streams = res.data?.streams || [];

        for (const s of streams) {
            const fullText = `${s.name || ''} ${s.title || ''} ${s.description || ''}`;
            // Trava PT-BR: só adiciona o torrent se passar no filtro de português
            if (s.infoHash && isPtBrStream(fullText, onlyDubbed)) {
                results.push({
                    infoHash: s.infoHash.toLowerCase(),
                    title: s.title || s.description || s.name || 'Stream PT-BR',
                    fileIdx: s.fileIdx ?? null,
                    source: s.name || 'Indexer PT-BR'
                });
            }
        }
    } catch (err) {
        console.error('Erro no indexador externo:', err.message);
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

app.get(['/', '/configure', '/:config/configure'], (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <title>Configurar TorBox PT-BR</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
            .card { background: #1e293b; padding: 2rem; border-radius: 12px; width: 100%; max-width: 460px; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
            h2 { margin-top: 0; color: #4ade80; }
            label { display: block; margin-top: 1rem; font-size: 0.9rem; color: #cbd5e1; }
            input[type="text"], input[type="password"] { width: 100%; padding: 0.75rem; margin-top: 0.4rem; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #fff; box-sizing: border-box; }
            .checkbox-label { display: flex; align-items: center; gap: 8px; margin-top: 0.8rem; cursor: pointer; }
            button { width: 100%; margin-top: 1.5rem; padding: 0.85rem; background: #16a34a; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: bold; cursor: pointer; }
            button:hover { background: #15803d; }
            .hint { font-size: 0.8rem; color: #94a3b8; margin-top: 0.3rem; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>🇧🇷 TorBox PT-BR Addon</h2>
            <p class="hint">Busca exclusiva de Filmes, Séries e Animes em Português.</p>
            
            <label>TorBox API Key:</label>
            <input type="password" id="apiKey" placeholder="Cole sua chave da conta TorBox..." />
            
            <label>Indexador Upstream (Já configurado para PT-BR):</label>
            <input type="text" id="indexerUrl" value="${DEFAULT_PTBR_INDEXER}" />
            <div class="hint">Inclui Comando, BluDV, Lapumia, Mico Leão Dublado e Nyaa PT-BR.</div>

            <label class="checkbox-label">
                <input type="checkbox" id="onlyDubbed" />
                Apenas Dublado / Dual Áudio (Ignorar apenas legendados)
            </label>

            <label class="checkbox-label">
                <input type="checkbox" id="cachedOnly" checked />
                Mostrar apenas streams em cache instantâneo ([TB+])
            </label>

            <button onclick="install()">Instalar Addon PT-BR no Stremio</button>
        </div>
        <script>
            function install() {
                const apiKey = document.getElementById('apiKey').value.trim();
                const indexerUrl = document.getElementById('indexerUrl').value.trim();
                const onlyDubbed = document.getElementById('onlyDubbed').checked;
                const cachedOnly = document.getElementById('cachedOnly').checked;
                
                const config = { apiKey, indexerUrl, onlyDubbed, cachedOnly };
                const encoded = btoa(JSON.stringify(config)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
                const stremioUrl = 'stremio://' + window.location.host + '/' + encoded + '/manifest.json';
                window.location.href = stremioUrl;
            }
        </script>
    </body>
    </html>
    `);
});

app.get('/manifest.json', (req, res) => {
    res.json(buildManifest(false));
});

app.get('/:config/manifest.json', (req, res) => {
    const config = decodeConfig(req.params.config);
    res.json(buildManifest(Boolean(config.apiKey || config.indexerUrl)));
});

app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const { config: configStr, type, id } = req.params;
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
    const candidates = await fetchCandidateTorrents(
        type,
        id,
        config.indexerUrl,
        config.apiKey,
        metadata,
        Boolean(config.onlyDubbed)
    );

    if (!candidates.length) {
        return res.json({ streams: [] });
    }

    if (!config.apiKey) {
        const p2pStreams = candidates.map(c => ({
            name: '🇧🇷 P2P PT-BR',
            title: c.title,
            infoHash: c.infoHash,
            ...(c.fileIdx !== null ? { fileIdx: c.fileIdx } : {})
        }));
        return res.json({ streams: p2pStreams });
    }

    const hashes = candidates.map(c => c.infoHash);
    const cachedMap = await checkTorBoxCache(config.apiKey, hashes);

    const streams = [];

    for (const item of candidates) {
        const isCached = Boolean(cachedMap[item.infoHash]);
        if (config.cachedOnly && !isCached) continue;

        const badge = isCached ? '⚡ [TB+ 🇧🇷]' : '⏳ [TB Download 🇧🇷]';
        const resolveUrl = `${host}/${configStr}/resolve/${item.infoHash}/${season ?? 0}/${episode ?? 0}`;

        streams.push({
            name: `${badge} TorBox`,
            title: item.title,
            url: resolveUrl,
            behaviorHints: {
                bingeGroup: `torbox-ptbr-${isCached ? 'cached' : 'uncached'}`
            }
        });
    }

    res.json({ streams });
});

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
            headers: { Authorization: `Bearer ${apiKey}` },
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

    } catch (err) {
        res.status(500).send('Erro ao resolver link junto à API do TorBox.');
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
}

module.exports = app;
