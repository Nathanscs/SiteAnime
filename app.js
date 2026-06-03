import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging.js";

import { THESPORTSDB_API_KEY, FIREBASE_CONFIG } from "./config.js";

// ==========================================
// 1. CONFIGURAÇÃO FIREBASE (Substitua pelas suas chaves)
// ==========================================
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
let currentUser = null;

// ==========================================
// 2. TEMA E UI
// ==========================================
const themeToggleBtn = document.getElementById('theme-toggle');
let isDark = localStorage.getItem('theme') !== 'light';
document.body.setAttribute('data-theme', isDark ? 'dark' : 'light');

themeToggleBtn.addEventListener('click', () => {
    isDark = !isDark;
    document.body.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
});

// ==========================================
// 3. AUTENTICAÇÃO & SINCRONIZAÇÃO NUVEM
// ==========================================
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const userInfo = document.getElementById('user-info');
const userAvatar = document.getElementById('user-avatar');

loginBtn.addEventListener('click', () => {
    const provider = new GoogleAuthProvider();
    signInWithPopup(auth, provider);
});

logoutBtn.addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        loginBtn.classList.add('hidden');
        userInfo.classList.remove('hidden');
        userAvatar.src = user.photoURL;
        await syncFavoritesFromCloud(); // Baixa favoritos do Firebase
    } else {
        loginBtn.classList.remove('hidden');
        userInfo.classList.add('hidden');
    }
});

// ==========================================
// 4. FAVORITOS (LOCAL & CLOUD)
// ==========================================
let favorites = JSON.parse(localStorage.getItem('favorites')) || [];

async function toggleFavorite(leagueId, leagueName) {
    const index = favorites.findIndex(f => f.id === leagueId);
    if (index > -1) favorites.splice(index, 1);
    else favorites.push({ id: leagueId, name: leagueName });

    localStorage.setItem('favorites', JSON.stringify(favorites));
    renderFavorites();
    updateCalendar();

    // Sincroniza com Firestore se logado
    if (currentUser) {
        await setDoc(doc(db, "users", currentUser.uid), { favorites });
    }
}

async function syncFavoritesFromCloud() {
    const docRef = doc(db, "users", currentUser.uid);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
        favorites = docSnap.data().favorites || [];
        localStorage.setItem('favorites', JSON.stringify(favorites));
        renderFavorites();
        updateCalendar();
    }
}

function renderFavorites() {
    const list = document.getElementById('favorites-list');
    list.innerHTML = '';
    favorites.forEach(fav => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${fav.name}</span> <button>❌</button>`;
        li.querySelector('button').onclick = () => toggleFavorite(fav.id, fav.name);
        list.appendChild(li);
    });
}

// ==========================================
// 5. INTEGRAÇÃO API (TheSportsDB - Esportes Convencionais)
// ==========================================
// Chave premium do TheSportsDB (defina em config.js)
const API_KEY = THESPORTSDB_API_KEY;
const API_BASE = `https://www.thesportsdb.com/api/v1/json/${API_KEY}/`;

// Sempre exibir datas/horas no fuso de Brasília
const BR_TIME_ZONE = 'America/Sao_Paulo';

if (!API_KEY || API_KEY === 'COLOQUE_SUA_CHAVE_PREMIUM_AQUI') {
    console.warn('TheSportsDB API key não configurada. Edite o arquivo ./config.js');
}

// Cache simples para evitar bater em all_leagues.php a cada tecla na busca
let allLeaguesCache = null;
let allLeaguesCacheAt = 0;
const ALL_LEAGUES_TTL_MS = 6 * 60 * 60 * 1000;

function normalizeText(value) {
    return (value || '')
        .toString()
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '');
}

function getBrasiliaDateKey(dateObj) {
    // en-CA => YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: BR_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(dateObj);
}

function parseDateKeyToUtcMs(dateKey) {
    const [y, m, d] = (dateKey || '').split('-').map(Number);
    if (!y || !m || !d) return NaN;
    return Date.UTC(y, m - 1, d);
}

function addDaysToDateKey(dateKey, days) {
    const baseMs = parseDateKeyToUtcMs(dateKey);
    if (Number.isNaN(baseMs)) return dateKey;
    const next = new Date(baseMs + (days * 24 * 60 * 60 * 1000));
    const yyyy = next.getUTCFullYear();
    const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(next.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function formatDateBrasilia(dateObj) {
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: BR_TIME_ZONE,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    }).format(dateObj);
}

function formatTimeBrasilia(dateObj) {
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: BR_TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(dateObj);
}

function toApiUtcIso(dateEvent, strTime) {
    if (!dateEvent || !strTime) return null;
    const time = String(strTime).trim();
    if (!time) return null;
    const normalizedTime = time.length === 5 ? `${time}:00` : time; // HH:mm -> HH:mm:ss
    return `${dateEvent}T${normalizedTime}Z`;
}

async function getAllLeagues() {
    const now = Date.now();
    if (allLeaguesCache && (now - allLeaguesCacheAt) < ALL_LEAGUES_TTL_MS) return allLeaguesCache;

    const res = await fetch(`${API_BASE}all_leagues.php`);
    if (!res.ok) throw new Error(`Falha ao carregar ligas: HTTP ${res.status}`);
    const data = await res.json();
    allLeaguesCache = data?.leagues || [];
    allLeaguesCacheAt = now;
    return allLeaguesCache;
}

function renderLeagueResults(leagues, title) {
    const list = document.getElementById('sports-list');
    if (!list) return;
    list.innerHTML = '';

    const headerLi = document.createElement('li');
    headerLi.innerHTML = `<strong>${title}</strong>`;
    list.appendChild(headerLi);

    const backLi = document.createElement('li');
    backLi.innerHTML = `<button id="back-sports-btn">🔙 Voltar</button>`;
    list.appendChild(backLi);
    document.getElementById('back-sports-btn').onclick = fetchSports;

    if (!leagues || leagues.length === 0) {
        const emptyLi = document.createElement('li');
        emptyLi.textContent = 'Nenhum campeonato encontrado.';
        list.appendChild(emptyLi);
        return;
    }

    leagues.forEach(league => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${league.strLeague}</span> <button title="Favoritar">⭐</button>`;
        li.querySelector('button').onclick = (e) => {
            e.stopPropagation();
            toggleFavorite(league.idLeague, league.strLeague);
        };
        list.appendChild(li);
    });
}

function setupGlobalSearch() {
    const searchInput = document.getElementById('global-search');
    if (!searchInput) return;

    let debounceHandle;
    searchInput.addEventListener('input', () => {
        clearTimeout(debounceHandle);
        debounceHandle = setTimeout(async () => {
            const query = normalizeText(searchInput.value);

            // Se limpar a busca, volta para a lista de esportes
            if (!query) {
                fetchSports();
                return;
            }

            // Evita busca com 1 caractere (muito resultado)
            if (query.length < 2) return;

            const list = document.getElementById('sports-list');
            if (list) list.innerHTML = '<li>Pesquisando campeonatos...</li>';

            try {
                const allLeagues = await getAllLeagues();
                const results = allLeagues
                    .filter(l => normalizeText(l.strLeague).includes(query))
                    .slice(0, 80)
                    .sort((a, b) => (a.strLeague || '').localeCompare(b.strLeague || ''));

                renderLeagueResults(results, `Resultados para: "${searchInput.value.trim()}"`);
            } catch (e) {
                console.error('Erro na busca global:', e);
                if (list) list.innerHTML = '<li>Erro ao pesquisar. Verifique sua conexão/chave da API.</li>';
            }
        }, 300);
    });

    // Enter força pesquisa imediata
    searchInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        clearTimeout(debounceHandle);
        // Reusa o handler de input
        searchInput.dispatchEvent(new Event('input'));
    });
}

function setupViewTabs() {
    const tabList = document.getElementById('tab-list');
    const tabCalendar = document.getElementById('tab-calendar');
    const viewList = document.getElementById('view-list');
    const viewCalendar = document.getElementById('view-calendar');
    if (!tabList || !tabCalendar || !viewList || !viewCalendar) return;

    const setView = (viewName) => {
        const isList = viewName === 'list';
        tabList.classList.toggle('active', isList);
        tabCalendar.classList.toggle('active', !isList);
        tabList.setAttribute('aria-selected', String(isList));
        tabCalendar.setAttribute('aria-selected', String(!isList));
        viewList.classList.toggle('view-active', isList);
        viewCalendar.classList.toggle('view-active', !isList);
    };

    tabList.addEventListener('click', () => setView('list'));
    tabCalendar.addEventListener('click', () => setView('calendar'));
}

function formatDayLabel(dateObj) {
    const todayKey = getBrasiliaDateKey(new Date());
    const dateKey = getBrasiliaDateKey(dateObj);
    const diffDays = Math.round((parseDateKeyToUtcMs(dateKey) - parseDateKeyToUtcMs(todayKey)) / (24 * 60 * 60 * 1000));
    if (diffDays === 0) return 'Hoje';
    if (diffDays === 1) return 'Amanhã';
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: BR_TIME_ZONE,
        weekday: 'long',
        day: '2-digit',
        month: 'short'
    }).format(dateObj);
}

function renderUpcomingList(allEvents) {
    const container = document.getElementById('upcoming-list');
    const subtitle = document.getElementById('upcoming-subtitle');
    if (!container) return;

    if (!favorites.length) {
        if (subtitle) subtitle.textContent = 'Adicione ligas aos favoritos para ver jogos aqui.';
        container.innerHTML = '<div class="event-card">Sem favoritos ainda. Clique em ⭐ em uma liga para começar.</div>';
        return;
    }

    if (subtitle) subtitle.textContent = `Baseado em ${favorites.length} liga(s) favorita(s)`;

    const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;
    const events = (allEvents || [])
        .filter(ev => ev?.start)
        .map(ev => {
            const startValue = ev.start;
            // all-day vindo como YYYY-MM-DD precisa ser interpretado no fuso BR para não “voltar” um dia.
            const startDate = (ev.allDay && typeof startValue === 'string' && dateOnlyRegex.test(startValue))
                ? new Date(`${startValue}T12:00:00-03:00`)
                : new Date(startValue);

            return {
                ...ev,
                startDate
            };
        })
        .filter(ev => !isNaN(ev.startDate.getTime()))
        .sort((a, b) => a.startDate - b.startDate)
        .slice(0, 120);

    if (!events.length) {
        container.innerHTML = '<div class="event-card">Nenhum evento encontrado para os seus favoritos.</div>';
        return;
    }

    container.innerHTML = '';
    let currentDayKey = '';
    for (const ev of events) {
        const dayKey = getBrasiliaDateKey(ev.startDate);
        if (dayKey !== currentDayKey) {
            currentDayKey = dayKey;
            const dayDiv = document.createElement('div');
            dayDiv.className = 'day-group';
            dayDiv.textContent = formatDayLabel(ev.startDate);
            container.appendChild(dayDiv);
        }

        const card = document.createElement('div');
        card.className = 'event-card';

        const timeText = ev.allDay ? 'Dia todo' : formatTimeBrasilia(ev.startDate);

        card.innerHTML = `
            <div class="event-top">
                <span class="pill">${ev.leagueName || 'Favorito'}</span>
                <button class="small ghost upcoming-details-btn" type="button">Detalhes</button>
            </div>
            <div class="event-title">${ev.title || 'Evento'}</div>
            <div class="event-meta">
                <span>${formatDateBrasilia(ev.startDate)}</span>
                <span>${timeText}</span>
            </div>
        `;

        const btn = card.querySelector('.upcoming-details-btn');
        btn?.addEventListener('click', () => {
            showMatchDetails(ev.title, ev.leagueName, ev.sportName || 'Futebol', formatDateBrasilia(ev.startDate), timeText);
        });

        container.appendChild(card);
    }
}

// Dicionário para traduzir os esportes da API para o Português na interface
const traducaoEsportes = {
    "Soccer": "Futebol",
    "American Football": "Futebol americano",
    "Australian Football": "Futebol australiano",
    "Gaelic Football": "Futebol gaélico",
    "Rugby": "Rúgbi",
    "Rugby League": "Rúgbi (League)",
    "Rugby Union": "Rúgbi (Union)",
    "Cricket": "Críquete",
    "Basketball": "Basquete",
    "Baseball": "Beisebol",
    "Softball": "Softbol",
    "Ice Hockey": "Hóquei no gelo",
    "Field Hockey": "Hóquei em campo",
    "Hockey": "Hóquei",
    "Handball": "Handebol",
    "Volleyball": "Vôlei",
    "Beach Volleyball": "Vôlei de praia",
    "Tennis": "Tênis",
    "Table Tennis": "Tênis de mesa",
    "Badminton": "Badminton",
    "Squash": "Squash",
    "Racquetball": "Raquetebol",
    "Pickleball": "Pickleball",
    "Golf": "Golfe",
    "Bowling": "Boliche",
    "Darts": "Dardos",
    "Snooker": "Snooker",
    "Pool": "Sinuca",
    "Chess": "Xadrez",
    "Cycling": "Ciclismo",
    "Road Cycling": "Ciclismo de estrada",
    "Track Cycling": "Ciclismo de pista",
    "Mountain Biking": "Mountain bike",
    "Athletics": "Atletismo",
    "Gymnastics": "Ginástica",
    "Artistic Gymnastics": "Ginástica artística",
    "Rhythmic Gymnastics": "Ginástica rítmica",
    "Swimming": "Natação",
    "Diving": "Saltos ornamentais",
    "Water Polo": "Polo aquático",
    "Rowing": "Remo",
    "Canoeing": "Canoagem",
    "Kayaking": "Caiaque",
    "Sailing": "Vela",
    "Surfing": "Surfe",
    "Skateboarding": "Skate",
    "Snowboarding": "Snowboard",
    "Skiing": "Esqui",
    "Alpine Skiing": "Esqui alpino",
    "Cross Country Skiing": "Esqui cross-country",
    "Biathlon": "Biátlon",
    "Triathlon": "Triatlo",
    "Modern Pentathlon": "Pentatlo moderno",
    "Fencing": "Esgrima",
    "Shooting": "Tiro esportivo",
    "Archery": "Tiro com arco",
    "Equestrian": "Hipismo",
    "Wrestling": "Luta olímpica",
    "Judo": "Judô",
    "Karate": "Caratê",
    "Taekwondo": "Taekwondo",
    "Weightlifting": "Levantamento de peso",
    "Boxing": "Boxe",
    "MMA": "MMA",
    "Kickboxing": "Kickboxing",
    "Muay Thai": "Muay thai",
    "Fighting": "Artes marciais",
    "Motorsport": "Automobilismo",
    "Motor Sport": "Automobilismo",
    "eSports": "eSports",
    "Esports": "eSports",
    "Lacrosse": "Lacrosse",
    "Netball": "Netebol",
    "Sepak Takraw": "Sepak takraw",
    "Climbing": "Escalada",
    "Sport Climbing": "Escalada esportiva",
    "Sumo": "Sumô",
    "Kabaddi": "Kabaddi",
    "Bandy": "Bandy",
    "Pesapallo": "Pesäpallo",
    "Extreme Sports": "Esportes radicais"
};

async function fetchSports() {
    const sportsList = document.getElementById('sports-list');
    sportsList.innerHTML = '<li>Carregando esportes...</li>';

    try {
        const res = await fetch(`${API_BASE}all_sports.php`);
        if (!res.ok) throw new Error(`Erro de conexão HTTP: ${res.status}`);

        const data = await res.json();

        // Verifica se a API devolveu algo vazio ou bloqueou a resposta
        if (!data || !data.sports) throw new Error("A API não retornou a lista de esportes.");

        sportsList.innerHTML = '';

        data.sports.forEach(sport => {
            const nomeExibicao = traducaoEsportes[sport.strSport] || sport.strSport;
            const li = document.createElement('li');
            li.textContent = nomeExibicao;
            li.onclick = () => fetchLeagues(sport.strSport, nomeExibicao);
            sportsList.appendChild(li);
        });

    } catch (e) {
        console.warn("A API falhou ou atingiu o limite. Carregando lista de segurança:", e);

        // Limpa a mensagem de erro e avisa discretamente que está no modo offline/fallback
        sportsList.innerHTML = '<li style="color: #e94560; font-size: 0.8rem; text-align: center;">⚠️ API instável. Modo de segurança ativo.</li>';

        // LISTA DE SEGURANÇA (Garante que o site nunca fique em branco)
        const esportesDeEmergencia = [
            { idAPI: "Soccer", nomePtBr: "Futebol" },
            { idAPI: "Basketball", nomePtBr: "Basquete" },
            { idAPI: "Motorsport", nomePtBr: "Automobilismo" },
            { idAPI: "Volleyball", nomePtBr: "Vôlei" },
            { idAPI: "Fighting", nomePtBr: "Artes marciais" },
            { idAPI: "Surfing", nomePtBr: "Surfe" }
        ];

        esportesDeEmergencia.forEach(sport => {
            const li = document.createElement('li');
            li.textContent = sport.nomePtBr;

            // Passa o ID correto em inglês para a próxima função (fetchLeagues) continuar funcionando
            li.onclick = () => fetchLeagues(sport.idAPI, sport.nomePtBr);

            sportsList.appendChild(li);
        });
    }
}

async function fetchLeagues(sportNameId, nomePtBr) {
    const list = document.getElementById('sports-list');
    list.innerHTML = '<li>Buscando ligas...</li>';

    try {
        // Busca diretamente pelo esporte. É mais eficiente para esportes convencionais.
        const res = await fetch(`${API_BASE}search_all_leagues.php?s=${encodeURIComponent(sportNameId)}`);
        const data = await res.json();

        // Header + botão voltar (mantém o <ul> com <li> válidos)
        list.innerHTML = '';
        const headerLi = document.createElement('li');
        headerLi.innerHTML = `<strong>Ligas de ${nomePtBr}</strong>`;
        list.appendChild(headerLi);

        const backLi = document.createElement('li');
        backLi.innerHTML = `<button id="back-sports-btn">🔙 Voltar</button>`;
        list.appendChild(backLi);
        document.getElementById('back-sports-btn').onclick = fetchSports;

        // A API curiosamente envia a lista de ligas dentro do objeto 'countrys'
        if (data?.countrys && data.countrys.length > 0) {
            data.countrys.forEach(league => {
                const li = document.createElement('li');
                li.innerHTML = `<span>${league.strLeague}</span> <button title="Favoritar">⭐</button>`;
                li.querySelector('button').onclick = (e) => {
                    e.stopPropagation();
                    toggleFavorite(league.idLeague, league.strLeague);
                };
                list.appendChild(li);
            });
            return;
        }

        // Fallback 1: all_leagues.php costuma funcionar melhor na chave grátis
        // e já vem com idLeague, permitindo favoritar normalmente.
        try {
            const resAll = await fetch(`${API_BASE}all_leagues.php`);
            const allData = await resAll.json();
            const leagues = (allData?.leagues || [])
                .filter(l => (l.strSport || '').toLowerCase() === (sportNameId || '').toLowerCase());

            if (leagues.length > 0) {
                const maxToShow = 60;
                leagues
                    .sort((a, b) => (a.strLeague || '').localeCompare(b.strLeague || ''))
                    .slice(0, maxToShow)
                    .forEach(league => {
                        const li = document.createElement('li');
                        li.innerHTML = `<span>${league.strLeague}</span> <button title="Favoritar">⭐</button>`;
                        li.querySelector('button').onclick = (e) => {
                            e.stopPropagation();
                            toggleFavorite(league.idLeague, league.strLeague);
                        };
                        list.appendChild(li);
                    });

                const infoLi = document.createElement('li');
                infoLi.style.fontSize = '0.85rem';
                infoLi.style.opacity = '0.9';
                infoLi.textContent = `Mostrando ${Math.min(leagues.length, maxToShow)} de ${leagues.length} ligas (modo fallback).`;
                list.appendChild(infoLi);
                return;
            }
        } catch (e) {
            console.warn('Fallback all_leagues.php falhou:', e);
        }

        // Fallback 2: A API grátis costuma falhar com Automobilismo ao buscar dessa forma.
        // Nós forçamos as IDs reais do TheSportsDB para você não ficar sem F1.
        if (sportNameId === "Motorsport") {
            const ligasMotorsport = [
                { id: '4370', nome: 'Formula 1' },
                { id: '4371', nome: 'Formula E' },
                { id: '4372', nome: 'MotoGP' },
                { id: '4396', nome: 'World Superbike' }
            ];

            ligasMotorsport.forEach(league => {
                const li = document.createElement('li');
                li.innerHTML = `<span>${league.nome}</span> <button title="Favoritar">⭐</button>`;
                li.querySelector('button').onclick = (e) => {
                    e.stopPropagation();
                    toggleFavorite(league.id, league.nome);
                };
                list.appendChild(li);
            });
            return;
        }

        {
            // Fallback: A API grátis costuma falhar com Automobilismo ao buscar dessa forma.
            const li = document.createElement('li');
            li.textContent = 'Nenhuma liga encontrada para este esporte na versão gratuita.';
            list.appendChild(li);
        }
    } catch (e) {
        console.error("Erro ao buscar as ligas:", e);
        list.innerHTML = `<li>Erro na comunicação com a API. Tente novamente.</li><button id="back-sports-btn">🔙 Voltar</button>`;
        document.getElementById('back-sports-btn').onclick = fetchSports;
    }
}

// ==========================================
// 6. CALENDÁRIO, DASHBOARD E EVENTOS REAIS/SIMULADOS
// ==========================================
let calendar;

function initCalendar() {
    const calendarEl = document.getElementById('calendar');
    if (!calendarEl) {
        console.warn("Elemento #calendar não encontrado. Pulando init do calendário.");
        return;
    }

    // FullCalendar é carregado via <script> no index.html e expõe o namespace global `FullCalendar`.
    if (!window.FullCalendar?.Calendar) {
        console.error("FullCalendar não carregou. Verifique o CDN no index.html.");
        return;
    }

    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'pt-br',
        timeZone: BR_TIME_ZONE,
        headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay'
        },
        eventTimeFormat: {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        },
        height: 'auto'
    });

    calendar.render();
}

async function updateCalendar() {
    if (!calendar) return;
    calendar.removeAllEvents();

    const dashToday = document.getElementById('dash-today');
    const dashWeek = document.getElementById('dash-week');
    const dashLive = document.getElementById('dash-live');

    let todayCount = 0;
    let liveEventHTML = "";
    const hoje = new Date();
    const hojeFormatado = getBrasiliaDateKey(hoje);

    // Se não houver favoritos, limpa o estado de carregamento do painel
    if (favorites.length === 0) {
        if (dashToday) dashToday.innerText = "0 jogos hoje";
        if (dashWeek) dashWeek.innerText = "0 campeonatos monitorados";
        if (dashLive) dashLive.innerHTML = "Sem eventos no momento";
        return;
    }

    function demoEventsForFavorite(fav) {
        const horaSimulada = new Date();
        horaSimulada.setHours(horaSimulada.getHours() + 1);
        const horaFormatada = horaSimulada.toTimeString().split(' ')[0];

        // 2. Define o primeiro campeonato favoritado como "Ao Vivo" no momento
        if (!liveEventHTML) {
            liveEventHTML = `<div style="color: #e94560; font-weight: bold;">🔴 ${fav.name}: Rodada em Andamento</div>`;
        }

        return [
            {
                title: `⚽ Clássico Principal - (${fav.name})`,
                start: `${hojeFormatado}T${horaFormatada}-03:00`,
                allDay: false
            },
            {
                title: `🏁 Treino Classificatório / Próxima Fase - (${fav.name})`,
                start: `${addDaysToDateKey(hojeFormatado, 1)}T14:00:00-03:00`,
                allDay: false
            },
            {
                title: `🏀 Confronto de Conferência - (${fav.name})`,
                start: `${addDaysToDateKey(hojeFormatado, 3)}T20:30:00-03:00`,
                allDay: false
            }
        ];
    }

    const aggregatedForList = [];

    for (const fav of favorites) {
        try {
            let eventosParaRenderizar = [];

            // Para favoritos que são ligas, o endpoint correto é eventsnextleague.php
            const endpoints = [
                `${API_BASE}eventsnextleague.php?id=${encodeURIComponent(fav.id)}`,
                // fallback legado (algumas IDs retornam algo aqui)
                `${API_BASE}eventsnext.php?id=${encodeURIComponent(fav.id)}`
            ];

            let data = null;
            for (const url of endpoints) {
                try {
                    const res = await fetch(url);
                    if (!res.ok) continue;
                    const parsed = await res.json();
                    data = parsed;
                    if (parsed?.events?.length) break;
                } catch {
                    // tenta próximo endpoint
                }
            }

            // Se a API trouxer dados válidos, usamos os dados reais
            if (data?.events?.length) {
                eventosParaRenderizar = data.events
                    .filter(ev => ev?.dateEvent)
                    .map(ev => {
                        const eventDate = ev.dateEvent;
                        const allDay = !ev.strTime;

                        // strTime da API normalmente vem em UTC. Adicionamos Z para converter corretamente.
                        const startUtcIso = toApiUtcIso(eventDate, ev.strTime);
                        const startDateObj = startUtcIso ? new Date(startUtcIso) : null;
                        const brDateKey = allDay
                            ? eventDate
                            : getBrasiliaDateKey(startDateObj);

                        if (brDateKey === hojeFormatado) {
                            todayCount++;
                            if (!liveEventHTML) {
                                liveEventHTML = `<div style="color: #e94560; font-weight: bold;">🔴 ${fav.name}: evento hoje</div>`;
                            }
                        }

                        return {
                            title: `${ev.strEvent}`,
                            start: allDay ? eventDate : (startUtcIso || `${eventDate}T00:00:00Z`),
                            allDay
                        };
                    });
            }

            // Fallback: se veio vazio OU se todos endpoints falharam
            if (!eventosParaRenderizar.length) {
                console.warn(`Sem eventos reais para ${fav.name}. Gerando demonstração.`);
                eventosParaRenderizar = demoEventsForFavorite(fav);
                // Conta eventos de demonstração de hoje
                todayCount += eventosParaRenderizar.filter(ev => {
                    const d = new Date(ev.start);
                    return getBrasiliaDateKey(d) === hojeFormatado;
                }).length;
            }

            aggregatedForList.push(
                ...eventosParaRenderizar.map(ev => ({
                    ...ev,
                    leagueName: fav.name
                }))
            );

            // Estiliza e insere os eventos no FullCalendar
            const eventosEstilizados = eventosParaRenderizar.map(ev => ({
                ...ev,
                backgroundColor: isDark ? '#e94560' : '#4a90e2',
                borderColor: isDark ? '#e94560' : '#4a90e2',
                textColor: '#ffffff'
            }));

            calendar.addEventSource(eventosEstilizados);

        } catch (e) {
            console.error(`Erro ao processar a liga ${fav.name}:`, e);
            // Se falhar de vez (rede/JSON inválido), ainda assim mostra algo no calendário
            const demo = demoEventsForFavorite(fav);
            todayCount += demo.filter(ev => {
                const d = new Date(ev.start);
                return getBrasiliaDateKey(d) === hojeFormatado;
            }).length;
            aggregatedForList.push(
                ...demo.map(ev => ({
                    ...ev,
                    leagueName: fav.name
                }))
            );

            const eventosEstilizados = demo.map(ev => ({
                ...ev,
                backgroundColor: isDark ? '#e94560' : '#4a90e2',
                borderColor: isDark ? '#e94560' : '#4a90e2',
                textColor: '#ffffff'
            }));
            calendar.addEventSource(eventosEstilizados);
        }
    }

    // Atualiza a interface gráfica do Dashboard com as contagens
    if (dashToday) dashToday.innerText = `${todayCount} evento(s) hoje`;
    if (dashWeek) dashWeek.innerText = `${favorites.length} liga(s) favoritada(s)`;
    if (liveEventHTML && dashLive) {
        dashLive.innerHTML = liveEventHTML;
    }

    renderUpcomingList(aggregatedForList);
}

// ==========================================
// 7. PWA (Service Worker Registration)
// ==========================================
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('SW registrado!', reg))
        .catch(err => console.error('Erro no SW', err));
}

// ==========================================
// JOGOS EM DESTAQUE (Carrossel Global do Dia)
// ==========================================
async function fetchFeaturedTodayGames() {
    const track = document.getElementById('carousel-track');
    if (!track) return;

    track.innerHTML = '<div class="carousel-loading">Carregando jogos em destaque...</div>';

    const hoje = new Date();
    const hojeFormatado = getBrasiliaDateKey(hoje);

    let events = [];

    try {
        const response = await fetch(`${API_BASE}eventsday.php?d=${hojeFormatado}`);
        if (response.ok) {
            const data = await response.json();
            if (data && data.events && data.events.length > 0) {
                events = data.events.slice(0, 15);
            }
        }
    } catch (e) {
        console.warn("Falha ao buscar eventos reais do dia para o carrossel, usando demonstração:", e);
    }

    if (events.length === 0) {
        events = [
            {
                strEvent: "Real Madrid vs Barcelona",
                strLeague: "La Liga",
                strTime: "16:00:00",
                dateEvent: hojeFormatado,
                strSport: "Soccer",
                isLive: true
            },
            {
                strEvent: "Lakers vs Celtics",
                strLeague: "NBA",
                strTime: "21:30:00",
                dateEvent: hojeFormatado,
                strSport: "Basketball",
                isLive: false
            },
            {
                strEvent: "Manchester City vs Liverpool",
                strLeague: "Premier League",
                strTime: "14:30:00",
                dateEvent: hojeFormatado,
                strSport: "Soccer",
                isLive: false
            },
            {
                strEvent: "Flamengo vs Palmeiras",
                strLeague: "Campeonato Brasileiro",
                strTime: "18:00:00",
                dateEvent: hojeFormatado,
                strSport: "Soccer",
                isLive: false
            },
            {
                strEvent: "Fórmula 1 - GP de Mônaco",
                strLeague: "Formula 1",
                strTime: "10:00:00",
                dateEvent: hojeFormatado,
                strSport: "Motorsport",
                isLive: false
            },
            {
                strEvent: "Golden State Warriors vs Chicago Bulls",
                strLeague: "NBA",
                strTime: "23:00:00",
                dateEvent: hojeFormatado,
                strSport: "Basketball",
                isLive: false
            }
        ];
    }

    track.innerHTML = '';

    events.forEach(ev => {
        const { teamA, teamB } = parseEventTitle(ev.strEvent);
        const card = document.createElement('div');
        card.className = 'match-card';

        let sportEmoji = "🏆";
        if (ev.strSport === "Soccer") sportEmoji = "⚽";
        else if (ev.strSport === "Basketball") sportEmoji = "🏀";
        else if (ev.strSport === "Motorsport" || ev.strSport === "Formula 1") sportEmoji = "🏁";
        else if (ev.strSport === "Tennis") sportEmoji = "🎾";

        let timeText = ev.strTime ? ev.strTime.substring(0, 5) : "--:--";
        let isLive = ev.isLive || false;

        const statusClass = isLive ? 'match-status live' : 'match-status scheduled';
        const statusText = isLive ? '🔴 AO VIVO' : '⏰ Agendado';

        const letterA = teamA ? teamA.charAt(0) : '?';
        const letterB = teamB ? teamB.charAt(0) : '?';

        card.innerHTML = `
            <div class="match-league">
                <span>${sportEmoji}</span>
                <span>${ev.strLeague || 'Destaque'}</span>
            </div>
            <div class="match-teams">
                <div class="team-row">
                    <span class="team-icon-placeholder">${letterA}</span>
                    <span class="team-name">${teamA}</span>
                </div>
                ${teamB ? `
                <div class="team-row">
                    <span class="team-icon-placeholder">${letterB}</span>
                    <span class="team-name">${teamB}</span>
                </div>
                ` : ''}
            </div>
            <div class="match-footer">
                <span class="${statusClass}">${statusText}</span>
                <button class="small ghost carousel-details-btn" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; border-radius: 6px; font-weight: bold;">Detalhes</button>
                <span class="match-time">${timeText}</span>
            </div>
        `;

        const detailsBtn = card.querySelector('.carousel-details-btn');
        detailsBtn?.addEventListener('click', () => {
            showMatchDetails(ev.strEvent, ev.strLeague, ev.strSport, formatDateBrasilia(new Date(ev.dateEvent)), timeText);
        });

        track.appendChild(card);
    });
}

function parseEventTitle(title) {
    if (!title) return { teamA: 'Time A', teamB: 'Time B' };
    let splitChar = ' vs ';
    if (title.includes(' vs ')) splitChar = ' vs ';
    else if (title.includes(' @ ')) splitChar = ' @ ';
    else if (title.includes(' - ')) splitChar = ' - ';
    else {
        return { teamA: title, teamB: '' };
    }
    const parts = title.split(splitChar);
    return {
        teamA: parts[0]?.trim() || 'Time A',
        teamB: parts[1]?.trim() || 'Time B'
    };
}

function setupCarouselNavigation() {
    const prevBtn = document.getElementById('carousel-prev');
    const nextBtn = document.getElementById('carousel-next');
    const track = document.getElementById('carousel-track');

    if (!prevBtn || !nextBtn || !track) return;

    prevBtn.addEventListener('click', () => {
        track.scrollBy({ left: -340, behavior: 'smooth' });
    });

    nextBtn.addEventListener('click', () => {
        track.scrollBy({ left: 340, behavior: 'smooth' });
    });
}

// ==========================================
// POPUP DE DETALHES DA PARTIDA (Modal)
// ==========================================
const DB_KNOWN_STARS = {
    // NBA
    "134879": "Victor Wembanyama", // Spurs
    "134862": "Jalen Brunson",     // Knicks
    "134863": "LeBron James",      // Lakers
    "134864": "Jayson Tatum",      // Celtics
    "134865": "Stephen Curry",     // Warriors
    // Soccer - Premier League
    "133613": "Erling Haaland",    // Man City
    "133602": "Mohamed Salah",     // Liverpool
    "133604": "Bukayo Saka",       // Arsenal
    // Soccer - La Liga
    "133738": "Vinícius Júnior",   // Real Madrid
    "133739": "Robert Lewandowski",// Barcelona
    // Soccer - Brasileirão
    "133937": "Pedro",             // Flamengo
    "133934": "Raphael Veiga",     // Palmeiras
};

const DB_NBA_STATS = {
    "celtics": { rank: "1º Leste", ppg: "120.6", star: "Jayson Tatum" },
    "knicks": { rank: "2º Leste", ppg: "112.8", star: "Jalen Brunson" },
    "bucks": { rank: "3º Leste", ppg: "119.0", star: "Giannis Antetokounmpo" },
    "cavaliers": { rank: "4º Leste", ppg: "112.6", star: "Donovan Mitchell" },
    "magic": { rank: "5º Leste", ppg: "110.5", star: "Paolo Banchero" },
    "pacers": { rank: "6º Leste", ppg: "123.3", star: "Tyrese Haliburton" },
    "76ers": { rank: "7º Leste", ppg: "114.6", star: "Joel Embiid" },
    "heat": { rank: "8º Leste", ppg: "110.1", star: "Jimmy Butler" },
    "bulls": { rank: "9º Leste", ppg: "112.3", star: "DeMar DeRozan" },
    "hawks": { rank: "10º Leste", ppg: "118.3", star: "Trae Young" },
    "nets": { rank: "11º Leste", ppg: "110.4", star: "Cam Thomas" },
    "raptors": { rank: "12º Leste", ppg: "112.4", star: "RJ Barrett" },
    "hornets": { rank: "13º Leste", ppg: "106.6", star: "LaMelo Ball" },
    "wizards": { rank: "14º Leste", ppg: "113.7", star: "Kyle Kuzma" },
    "pistons": { rank: "15º Leste", ppg: "109.9", star: "Cade Cunningham" },
    
    "thunder": { rank: "1º Oeste", ppg: "120.1", star: "Shai Gilgeous-Alexander" },
    "nuggets": { rank: "2º Oeste", ppg: "114.9", star: "Nikola Jokić" },
    "timberwolves": { rank: "3º Oeste", ppg: "113.0", star: "Anthony Edwards" },
    "clippers": { rank: "4º Oeste", ppg: "115.6", star: "Kawhi Leonard" },
    "mavericks": { rank: "5º Oeste", ppg: "117.9", star: "Luka Dončić" },
    "suns": { rank: "6º Oeste", ppg: "116.2", star: "Kevin Durant" },
    "pelicans": { rank: "7º Oeste", ppg: "115.1", star: "Zion Williamson" },
    "lakers": { rank: "8º Oeste", ppg: "118.0", star: "LeBron James" },
    "kings": { rank: "9º Oeste", ppg: "116.6", star: "De'Aaron Fox" },
    "warriors": { rank: "10º Oeste", ppg: "117.8", star: "Stephen Curry" },
    "rockets": { rank: "11º Oeste", ppg: "114.3", star: "Alperen Şengün" },
    "jazz": { rank: "12º Oeste", ppg: "115.7", star: "Lauri Markkanen" },
    "grizzlies": { rank: "13º Oeste", ppg: "105.8", star: "Ja Morant" },
    "spurs": { rank: "2º Oeste", ppg: "112.1", star: "Victor Wembanyama" },
    "blazers": { rank: "15º Oeste", ppg: "106.4", star: "Jerami Grant" }
};

function findNbaStats(teamName) {
    if (!teamName) return null;
    const nameLower = teamName.toLowerCase();
    for (const key in DB_NBA_STATS) {
        if (nameLower.includes(key)) {
            return DB_NBA_STATS[key];
        }
    }
    return null;
}


function findBestTeamMatch(teams, query, leagueName, sportName) {
    if (!teams || teams.length === 0) return null;
    
    const cleanQuery = query.toLowerCase().trim();
    const cleanLeague = (leagueName || '').toLowerCase().trim();
    const cleanSport = (sportName || '').toLowerCase().trim();
    
    let bestTeam = null;
    let maxScore = -1;
    
    for (const team of teams) {
        let score = 0;
        const teamNameLower = team.strTeam.toLowerCase();
        
        // Exact name match
        if (teamNameLower === cleanQuery) {
            score += 100;
        } else if (teamNameLower.includes(cleanQuery)) {
            score += 50;
        }
        
        // League match
        if (cleanLeague && team.strLeague && team.strLeague.toLowerCase().includes(cleanLeague)) {
            score += 30;
        }
        if (cleanLeague && team.strLeague && cleanLeague.includes(team.strLeague.toLowerCase())) {
            score += 30;
        }
        
        // Sport match
        if (cleanSport && team.strSport && (
            team.strSport.toLowerCase() === cleanSport || 
            (cleanSport === 'futebol' && team.strSport.toLowerCase() === 'soccer') || 
            (cleanSport === 'basquete' && team.strSport.toLowerCase() === 'basketball')
        )) {
            score += 20;
        }
        
        // Prefer main league team (e.g. NBA over NBA G League)
        if (cleanLeague === 'nba' && team.strLeague === 'NBA') {
            score += 10;
        }
        
        if (score > maxScore) {
            maxScore = score;
            bestTeam = team;
        }
    }
    
    return bestTeam;
}

async function fetchTeamDetails(name, leagueName, sportName) {
    if (!name) return null;
    try {
        const res = await fetch(`${API_BASE}searchteams.php?t=${encodeURIComponent(name.trim())}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data.teams && data.teams.length > 0) {
            return findBestTeamMatch(data.teams, name, leagueName, sportName);
        }
    } catch(e) {
        console.error("Error searching team", name, e);
    }
    return null;
}

async function fetchTeamRoster(teamId) {
    if (!teamId) return [];
    try {
        const res = await fetch(`${API_BASE}lookup_all_players.php?id=${teamId}`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.player || [];
    } catch(e) {
        console.error("Error getting roster for team", teamId, e);
    }
    return [];
}

async function fetchLeagueStandings(leagueName, teamName) {
    if (!leagueName || !teamName) return null;
    try {
        // 1. Find the league ID
        const resAll = await fetch(`${API_BASE}all_leagues.php`);
        if (!resAll.ok) return null;
        const dataAll = await resAll.json();
        const cleanLeague = leagueName.toLowerCase().trim();
        const league = (dataAll.leagues || []).find(l => 
            l.strLeague.toLowerCase() === cleanLeague || 
            l.strLeague.toLowerCase().includes(cleanLeague) ||
            (l.strLeagueAlternate && l.strLeagueAlternate.toLowerCase().includes(cleanLeague))
        );
        if (!league) return null;
        
        // 2. Fetch lookuptable with fallbacks for seasons
        const seasons = ['2025-2026', '2025', '2024-2025', '2024', '2023-2024', '2023'];
        for (const season of seasons) {
            const tableRes = await fetch(`${API_BASE}lookuptable.php?l=${league.idLeague}&s=${season}`);
            if (!tableRes.ok) continue;
            const text = await tableRes.text();
            if (!text || text.trim() === "") continue;
            const tableData = JSON.parse(text);
            if (tableData && tableData.table && tableData.table.length > 0) {
                // Find team row
                const row = tableData.table.find(t => 
                    t.strTeam.toLowerCase().includes(teamName.toLowerCase()) || 
                    teamName.toLowerCase().includes(t.strTeam.toLowerCase())
                );
                if (row) {
                    return row;
                }
            }
        }
    } catch(e) {
        console.error("Error getting standings", e);
    }
    return null;
}

async function fetchMatchupH2H(teamA, teamB) {
    if (!teamA || !teamB) return { winsA: 0, winsB: 0, draws: 0, total: 0 };
    try {
        const res = await fetch(`${API_BASE}searchevents.php?e=${encodeURIComponent(teamA + ' vs ' + teamB)}`);
        if (!res.ok) return { winsA: 0, winsB: 0, draws: 0, total: 0 };
        const data = await res.json();
        const events = data.event || [];
        
        let winsA = 0, winsB = 0, draws = 0;
        for (const ev of events) {
            if (ev.intHomeScore === null || ev.intAwayScore === null) continue;
            const hs = parseInt(ev.intHomeScore);
            const as = parseInt(ev.intAwayScore);
            
            const isHomeA = ev.strHomeTeam.toLowerCase().includes(teamA.toLowerCase()) || 
                            teamA.toLowerCase().includes(ev.strHomeTeam.toLowerCase());
            
            if (isHomeA) {
                if (hs > as) winsA++;
                else if (hs < as) winsB++;
                else draws++;
            } else {
                if (hs > as) winsB++;
                else if (hs < as) winsA++;
                else draws++;
            }
        }
        return { winsA, winsB, draws, total: winsA + winsB + draws };
    } catch(e) {
        console.error("Error fetching H2H", e);
    }
    return { winsA: 0, winsB: 0, draws: 0, total: 0 };
}

async function showMatchDetails(eventTitle, leagueName, sportName, dateText, timeText) {
    const modal = document.getElementById('details-modal');
    if (!modal) return;

    const sportBadge = document.getElementById('modal-sport-badge');
    const leagueEl = document.getElementById('modal-league-name');
    const teamAEl = document.getElementById('modal-team-a');
    const teamBEl = document.getElementById('modal-team-b');
    const venueEl = document.getElementById('modal-venue');
    const tvEl = document.getElementById('modal-tv');
    const statsEl = document.getElementById('modal-stats');
    const datetimeEl = document.getElementById('modal-datetime');
    const oddsEl = document.getElementById('modal-odds');

    const { teamA, teamB } = parseEventTitle(eventTitle);
    const leagueLower = (leagueName || '').toLowerCase();
    const teamALower = (teamA || '').toLowerCase();

    const sportUpper = (sportName || 'Esporte').toUpperCase();
    const isBasketball = sportUpper.includes('BASKET') || sportUpper.includes('BASQUETE');
    let sportEmoji = '🏆';
    if (sportUpper.includes('SOCCER') || sportUpper.includes('FUTEBOL')) sportEmoji = '⚽';
    else if (sportUpper.includes('BASKET') || sportUpper.includes('BASQUETE')) sportEmoji = '🏀';
    else if (sportUpper.includes('MOTOR') || sportUpper.includes('FÓRMULA')) sportEmoji = '🏁';
    else if (sportUpper.includes('TENNIS') || sportUpper.includes('TÊNIS')) sportEmoji = '🎾';

    if (sportBadge) sportBadge.textContent = `${sportEmoji} ${sportUpper}`;
    if (leagueEl) leagueEl.textContent = leagueName || 'Campeonato';
    if (teamAEl) teamAEl.textContent = teamA;
    if (teamBEl) teamBEl.textContent = teamB || 'Adversário';

    // Clear and set comparison UI loading states
    document.getElementById('modal-comp-name-a').textContent = teamA;
    document.getElementById('modal-comp-name-b').textContent = teamB || 'Adversário';
    document.getElementById('modal-comp-pos-a').textContent = '...';
    document.getElementById('modal-comp-pos-b').textContent = '...';
    document.getElementById('modal-comp-form-a').textContent = '...';
    document.getElementById('modal-comp-form-b').textContent = '...';
    document.getElementById('modal-comp-scorer-a').textContent = '...';
    document.getElementById('modal-comp-scorer-b').textContent = '...';
    document.getElementById('modal-comp-metric-a').textContent = '...';
    document.getElementById('modal-comp-metric-b').textContent = '...';
    
    document.getElementById('modal-h2h-wins-a').textContent = '-';
    document.getElementById('modal-h2h-draws').textContent = '-';
    document.getElementById('modal-h2h-wins-b').textContent = '-';
    document.getElementById('modal-h2h-bar-a').style.width = '33.3%';
    document.getElementById('modal-h2h-bar-draw').style.width = '33.3%';
    document.getElementById('modal-h2h-bar-b').style.width = '33.3%';

    const isNba = leagueLower.includes('nba');
    const posLabel = document.getElementById('modal-comp-pos-label');
    const formLabel = document.getElementById('modal-comp-form-label');
    const scorerLabel = document.getElementById('modal-comp-scorer-label');
    const metricLabel = document.getElementById('modal-comp-metric-label');
    const h2hTitleLabel = document.getElementById('modal-h2h-title-label');

    if (isNba) {
        if (posLabel) posLabel.textContent = '🏆 Posição na Conferência';
        if (formLabel) formLabel.textContent = '📈 Forma Recente';
        if (scorerLabel) scorerLabel.textContent = '🏀 Maior Pontuador';
        if (metricLabel) metricLabel.textContent = '🏀 Média de Pontos';
        if (h2hTitleLabel) h2hTitleLabel.textContent = '⚔️ Vitórias das Séries Passadas';
    } else {
        if (posLabel) posLabel.textContent = '🏆 Posição na Liga';
        if (formLabel) formLabel.textContent = '📈 Forma Recente';
        if (scorerLabel) scorerLabel.textContent = isBasketball ? '🏀 Cestinha' : '⚽ Artilheiro';
        if (metricLabel) metricLabel.textContent = isBasketball ? '🏀 Média de Pontos' : '🥅 Média de Gols';
        if (h2hTitleLabel) h2hTitleLabel.textContent = '⚔️ Confrontos Diretos (Histórico H2H)';
    }


    let venue = "Estádio / Arena do Evento";
    let tv = "Canais de esportes (ESPN / Sportv) ou streaming parceiro";
    let stats = `${teamA} vs ${teamB} - Estatísticas em processamento para esta temporada.`;
    let odds = `${teamA}: 40% | Empate: 30% | ${teamB}: 30%`;



    if (leagueLower.includes('premier league') || leagueLower.includes('inglês')) {
        tv = "ESPN e Disney+";
        venue = teamA ? `Estádio do ${teamA} (Inglaterra)` : "Estádio na Inglaterra";
        stats = `${teamA} disputa a Premier League nesta temporada. Equipes com alto índice de finalizações.`;
        odds = `${teamA}: 45% | Empate: 28% | ${teamB}: 27%`;
    } else if (leagueLower.includes('la liga') || leagueLower.includes('espanhol') || leagueLower.includes('espanha')) {
        tv = "ESPN e Disney+";
        venue = teamA ? `Estádio do ${teamA} (Espanha)` : "Estádio na Espanha";
        stats = `${teamA} enfrenta o ${teamB} pela La Liga espanhola. Conhecido pelo futebol tático e de posse de bola.`;
        odds = `${teamA}: 50% | Empate: 25% | ${teamB}: 25%`;
    } else if (leagueLower.includes('brasileiro') || leagueLower.includes('brasileirão') || leagueLower.includes('série a')) {
        tv = "Globo, SporTV e Premiere";
        venue = teamA ? `Estádio do ${teamA} (Brasil)` : "Estádio no Brasil";
        stats = `${teamA} vs ${teamB} pela Série A do Brasileirão. Disputa direta por pontos importantes na temporada.`;
        odds = `${teamA}: 42% | Empate: 33% | ${teamB}: 25%`;
    } else if (leagueLower.includes('nba') || leagueLower.includes('basquete') || sportUpper.includes('BASKET')) {
        tv = "ESPN, Disney+, Prime Video e NBA League Pass";
        venue = teamA ? `Arena do ${teamA} (EUA)` : "Arena nos EUA";
        stats = `${teamA} vs ${teamB} na temporada regular da NBA. Confronto com média histórica de mais de 210 pontos combinados.`;
        odds = `${teamA}: 52% | Empate: --% | ${teamB}: 48%`;
    } else if (leagueLower.includes('champions league') || leagueLower.includes('champions')) {
        tv = "TNT, Space e Max";
        venue = teamA ? `Estádio do ${teamA} (Europa)` : "Estádio na Europa";
        stats = `Fase decisiva da UEFA Champions League. Confronto de ida/volta entre as maiores potências do futebol mundial.`;
        odds = `${teamA}: 48% | Empate: 26% | ${teamB}: 26%`;
    } else if (leagueLower.includes('formula 1') || leagueLower.includes('fórmula 1') || sportUpper.includes('MOTOR')) {
        tv = "Band e BandSports";
        venue = "Circuito Oficial da F1";
        stats = "Treinos oficiais e corrida principal do Grande Prêmio. Disputa acirrada pelo campeonato de construtores.";
        odds = "Pole Position estimada: Red Bull (45%) | Ferrari (30%) | McLaren (25%)";
    }

    if (teamALower.includes('real madrid') && teamB.toLowerCase().includes('barcelona')) {
        venue = "Estádio Santiago Bernabéu (Madrid, Espanha)";
        tv = "ESPN e Disney+";
        stats = "Real Madrid: 1º colocado (87 pts) | Barcelona: 2º colocado (82 pts). O clássico lendário 'El Clásico'.";
        odds = "Real Madrid: 48% | Empate: 27% | Barcelona: 25%";
    } else if (teamALower.includes('manchester city') && teamB.toLowerCase().includes('liverpool')) {
        venue = "Etihad Stadium (Manchester, Inglaterra)";
        tv = "ESPN e Disney+";
        stats = "Confronto de gigantes. Manchester City: 1º colocado (91 pts) | Liverpool: 3º colocado (82 pts).";
        odds = "Man City: 52% | Empate: 24% | Liverpool: 24%";
    } else if (teamALower.includes('flamengo') && teamB.toLowerCase().includes('palmeiras')) {
        venue = "Estádio do Maracanã (Rio de Janeiro, Brasil)";
        tv = "Globo, SporTV e Premiere";
        stats = "Flamengo: 2º colocado (12 pts) | Palmeiras: 4º colocado (11 pts). Reedição de finais continentais recentes.";
        odds = "Flamengo: 45% | Empate: 30% | Palmeiras: 25%";
    } else if (teamALower.includes('lakers') && teamB.toLowerCase().includes('celtics')) {
        venue = "Crypto.com Arena (Los Angeles, EUA)";
        tv = "ESPN, Disney+ e NBA League Pass";
        stats = "A maior rivalidade da história da NBA. Lakers: 8º no Oeste (47-35) | Celtics: 1º no Leste (64-18).";
        odds = "Lakers: 46% | Celtics: 54%";
    }

    if (venueEl) venueEl.textContent = venue;
    if (tvEl) tvEl.textContent = tv;
    if (statsEl) statsEl.textContent = stats;
    if (datetimeEl) datetimeEl.textContent = `${dateText || '--/--/----'} às ${timeText || '--:--'}`;
    if (oddsEl) oddsEl.textContent = odds;

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Asynchronously fetch and populate the comparison statistics
    (async () => {
        try {
            const [teamAInfo, teamBInfo] = await Promise.all([
                fetchTeamDetails(teamA, leagueName, sportName),
                fetchTeamDetails(teamB, leagueName, sportName)
            ]);

            const resolvedNameA = teamAInfo ? teamAInfo.strTeam : teamA;
            const resolvedNameB = teamBInfo ? teamBInfo.strTeam : teamB;
            const teamAId = teamAInfo ? teamAInfo.idTeam : null;
            const teamBId = teamBInfo ? teamBInfo.idTeam : null;

            document.getElementById('modal-comp-name-a').textContent = resolvedNameA;
            document.getElementById('modal-comp-name-b').textContent = resolvedNameB;

            const [rosterA, rosterB] = await Promise.all([
                fetchTeamRoster(teamAId),
                fetchTeamRoster(teamBId)
            ]);

            const fallbackA = isNba ? findNbaStats(resolvedNameA) : null;
            const fallbackB = isNba ? findNbaStats(resolvedNameB) : null;

            const findStarPlayer = (teamId, roster, fallbackStar) => {
                if (!roster || roster.length === 0) return fallbackStar || "";
                const knownStar = DB_KNOWN_STARS[teamId] || fallbackStar;
                if (knownStar) {
                    const found = roster.find(p => p.strPlayer.toLowerCase().includes(knownStar.toLowerCase()));
                    if (found) return found.strPlayer;
                }

                if (!isBasketball) {
                    const striker = roster.find(p => p.strPosition && (
                        p.strPosition.toLowerCase().includes("forward") || 
                        p.strPosition.toLowerCase().includes("striker") || 
                        p.strPosition.toLowerCase().includes("wing")
                    ));
                    if (striker) return striker.strPlayer;
                } else {
                    const guardOrForward = roster.find(p => p.strPosition && (
                        p.strPosition.toLowerCase().includes("guard") || 
                        p.strPosition.toLowerCase().includes("forward")
                    ));
                    if (guardOrForward) return guardOrForward.strPlayer;
                }
                return roster[0]?.strPlayer || "";
            };

            const starA = findStarPlayer(teamAId, rosterA, fallbackA ? fallbackA.star : "");
            const starB = findStarPlayer(teamBId, rosterB, fallbackB ? fallbackB.star : "");

            document.getElementById('modal-comp-scorer-a').textContent = starA || '-';
            document.getElementById('modal-comp-scorer-b').textContent = starB || '-';

            const [standingsA, standingsB] = await Promise.all([
                fetchLeagueStandings(leagueName, resolvedNameA),
                fetchLeagueStandings(leagueName, resolvedNameB)
            ]);

            const renderFormPills = (formStr) => {
                if (!formStr || formStr.trim() === "") return "-";
                const cleanForm = formStr.trim().toUpperCase().split('');
                return cleanForm.map(char => {
                    let className = 'draw';
                    if (char === 'W') className = 'win';
                    else if (char === 'L') className = 'loss';
                    return `<span class="form-pill ${className}">${char}</span>`;
                }).join('');
            };

            if (isNba) {
                document.getElementById('modal-comp-pos-a').textContent = standingsA ? `${standingsA.intRank}º` : (fallbackA ? fallbackA.rank : '-');
                document.getElementById('modal-comp-pos-b').textContent = standingsB ? `${standingsB.intRank}º` : (fallbackB ? fallbackB.rank : '-');

                document.getElementById('modal-comp-form-a').innerHTML = standingsA ? renderFormPills(standingsA.strForm) : '-';
                document.getElementById('modal-comp-form-b').innerHTML = standingsB ? renderFormPills(standingsB.strForm) : '-';

                const ppgA = standingsA && standingsA.intGoalsFor ? (parseInt(standingsA.intGoalsFor) / parseInt(standingsA.intPlayed)).toFixed(1) : (fallbackA ? fallbackA.ppg : '-');
                const ppgB = standingsB && standingsB.intGoalsFor ? (parseInt(standingsB.intGoalsFor) / parseInt(standingsB.intPlayed)).toFixed(1) : (fallbackB ? fallbackB.ppg : '-');

                document.getElementById('modal-comp-metric-a').textContent = ppgA;
                document.getElementById('modal-comp-metric-b').textContent = ppgB;
            } else {
                document.getElementById('modal-comp-pos-a').textContent = standingsA ? `${standingsA.intRank}º` : '-';
                document.getElementById('modal-comp-pos-b').textContent = standingsB ? `${standingsB.intRank}º` : '-';

                document.getElementById('modal-comp-form-a').innerHTML = standingsA ? renderFormPills(standingsA.strForm) : '-';
                document.getElementById('modal-comp-form-b').innerHTML = standingsB ? renderFormPills(standingsB.strForm) : '-';

                if (standingsA && standingsA.intPlayed && parseInt(standingsA.intPlayed) > 0) {
                    const avgGoalsA = (parseInt(standingsA.intGoalsFor) / parseInt(standingsA.intPlayed)).toFixed(2);
                    document.getElementById('modal-comp-metric-a').textContent = avgGoalsA;
                } else {
                    document.getElementById('modal-comp-metric-a').textContent = '-';
                }
                if (standingsB && standingsB.intPlayed && parseInt(standingsB.intPlayed) > 0) {
                    const avgGoalsB = (parseInt(standingsB.intGoalsFor) / parseInt(standingsB.intPlayed)).toFixed(2);
                    document.getElementById('modal-comp-metric-b').textContent = avgGoalsB;
                } else {
                    document.getElementById('modal-comp-metric-b').textContent = '-';
                }
            }

            const h2h = await fetchMatchupH2H(resolvedNameA, resolvedNameB);
            const winsA = h2h.winsA;
            const winsB = h2h.winsB;
            const draws = isBasketball ? 0 : h2h.draws;
            const total = winsA + winsB + draws;

            if (total > 0) {
                const pctA = ((winsA / total) * 100).toFixed(1);
                const pctB = ((winsB / total) * 100).toFixed(1);
                const pctDraw = ((draws / total) * 100).toFixed(1);

                document.getElementById('modal-h2h-wins-a').textContent = `${winsA} Vitórias (${pctA}%)`;
                document.getElementById('modal-h2h-wins-b').textContent = `${winsB} Vitórias (${pctB}%)`;

                if (isBasketball) {
                    document.getElementById('modal-h2h-draws').style.display = 'none';
                    document.getElementById('modal-h2h-bar-draw').style.display = 'none';
                    document.getElementById('modal-h2h-bar-a').style.width = `${pctA}%`;
                    document.getElementById('modal-h2h-bar-b').style.width = `${pctB}%`;
                } else {
                    document.getElementById('modal-h2h-draws').style.display = 'inline';
                    document.getElementById('modal-h2h-draws').textContent = `${draws} Empates (${pctDraw}%)`;
                    document.getElementById('modal-h2h-bar-draw').style.display = 'block';
                    document.getElementById('modal-h2h-bar-a').style.width = `${pctA}%`;
                    document.getElementById('modal-h2h-bar-draw').style.width = `${pctDraw}%`;
                    document.getElementById('modal-h2h-bar-b').style.width = `${pctB}%`;
                }
            } else {
                document.getElementById('modal-h2h-wins-a').textContent = '-';
                document.getElementById('modal-h2h-wins-b').textContent = '-';
                if (isBasketball) {
                    document.getElementById('modal-h2h-draws').style.display = 'none';
                    document.getElementById('modal-h2h-bar-draw').style.display = 'none';
                    document.getElementById('modal-h2h-bar-a').style.width = '50%';
                    document.getElementById('modal-h2h-bar-b').style.width = '50%';
                } else {
                    document.getElementById('modal-h2h-draws').style.display = 'inline';
                    document.getElementById('modal-h2h-draws').textContent = 'Sem histórico';
                    document.getElementById('modal-h2h-bar-draw').style.display = 'block';
                    document.getElementById('modal-h2h-bar-a').style.width = '33.3%';
                    document.getElementById('modal-h2h-bar-draw').style.width = '33.4%';
                    document.getElementById('modal-h2h-bar-b').style.width = '33.3%';
                }
            }
        } catch (err) {
            console.error("Error populating match details comparison", err);
            document.getElementById('modal-comp-pos-a').textContent = '-';
            document.getElementById('modal-comp-pos-b').textContent = '-';
            document.getElementById('modal-comp-form-a').textContent = '-';
            document.getElementById('modal-comp-form-b').textContent = '-';
            document.getElementById('modal-comp-scorer-a').textContent = '-';
            document.getElementById('modal-comp-scorer-b').textContent = '-';
            document.getElementById('modal-comp-metric-a').textContent = '-';
            document.getElementById('modal-comp-metric-b').textContent = '-';
        }
    })();

}

function initDetailsModal() {
    const modal = document.getElementById('details-modal');
    const closeBtn = document.getElementById('modal-close');

    if (!modal || !closeBtn) return;

    const closeModal = () => {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
    };

    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });
}

// ==========================================
// 8. BOOTSTRAP (garante renderização inicial)
// ==========================================
// Sem isso, a lista de esportes fica vazia porque `fetchSports()` nunca era chamado.
document.addEventListener('DOMContentLoaded', () => {
    try {
        // Garante um tema explícito para CSS baseado em data-theme.
        if (!document.body.getAttribute('data-theme')) {
            document.body.setAttribute('data-theme', isDark ? 'dark' : 'light');
        }

        renderFavorites();
        setupGlobalSearch();
        setupViewTabs();
        initCalendar();
        fetchSports();
        updateCalendar();
        fetchFeaturedTodayGames();
        setupCarouselNavigation();
        initDetailsModal();

        const refreshBtn = document.getElementById('refresh-events');
        refreshBtn?.addEventListener('click', () => {
            updateCalendar();
            fetchFeaturedTodayGames();
        });

        // Controle do Menu Hambúrguer (Drawer)
        const hamburgerBtn = document.getElementById('hamburger-btn');
        const menuDrawer = document.getElementById('menu-drawer');
        const drawerOverlay = document.getElementById('drawer-overlay');
        const closeDrawerBtn = document.getElementById('close-drawer-btn');

        const openDrawer = () => {
            menuDrawer.classList.add('open');
            drawerOverlay.classList.add('open');
            document.body.style.overflow = 'hidden';
        };

        const closeDrawer = () => {
            menuDrawer.classList.remove('open');
            drawerOverlay.classList.remove('open');
            document.body.style.overflow = '';
        };

        hamburgerBtn?.addEventListener('click', openDrawer);
        closeDrawerBtn?.addEventListener('click', closeDrawer);
        drawerOverlay?.addEventListener('click', closeDrawer);

        // Fecha o menu quando alguma opção interna for clicada
        const drawerActions = document.querySelectorAll('.drawer-btn, .drawer-content button');
        drawerActions.forEach(element => {
            element.addEventListener('click', closeDrawer);
        });

    } catch (e) {
        console.error('Falha ao inicializar a aplicação:', e);
        const sportsList = document.getElementById('sports-list');
        if (sportsList) sportsList.innerHTML = '<li>Erro ao iniciar a aplicação. Veja o console.</li>';
    }
});