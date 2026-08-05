// 천사에게 - SillyTavern extension

function getPromptConstants() {
    const ctx = SillyTavern.getContext();
    const types = ctx.extension_prompt_types || { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
    const roles = ctx.extension_prompt_roles || { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
    return { types, roles };
}

const MODULE_NAME = 'pet_summoner';
const PROMPT_KEY = 'pet_summoner_prompt';
const SCHEMA_VERSION = 3;

const EMPTY_PET_FIELDS = Object.freeze({
    name: '', age: '', breed: '', gender: '', size: '', energy: '',
    likes: [], dislikes: [], habits: [], sensitive: '', episodes: [],
});

const defaultSettings = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    pets: {}, 
    activePetByCharacter: {}, 
    selectedTags: [],
    customNote: '',
    oneShot: true,
    tags: {
        interaction: ['애교부리기', '앙탈부리기', '장난치기', '그냥 등장하기', '혼자 할일하기', '반갑게 맞이하기', '곁에 있어주기', '관심 끌기', '질투하기', '놀라기', '신나기'],
        routine: ['산책하기', '밥 먹기', '약 먹이기 · 병원가기', '목욕 · 그루밍', '낮잠 · 잠자기', '장난감 놀이', '훈련 · 손'],
    },
    rainbowBridgeProfile: '',
});

function speciesLabel(species) {
    return species === 'cat' ? '고양이' : '강아지';
}

function generatePetId() {
    return `pet_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function escapeHtml(str) {
    return $('<div>').text(str == null ? '' : String(str)).html();
}

function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
}

function isMobile() {
    try {
        return window.matchMedia('(max-width:430px),(pointer:coarse)').matches;
    } catch {
        return window.innerWidth <= 430;
    }
}

// Peach Whisper 방식으로 이벤트 바인딩 단순화
function bindTap(selector, handler, namespace = '') {
    $(document).on(`click${namespace}`, selector, handler);
}

function addTapListener(el, handler) {
    if (!el) return;
    el.addEventListener('click', handler);
}

// ---------- 설정 로드 / 마이그레이션 ----------

function migrateIfNeeded(settings) {
    if (settings.schemaVersion === SCHEMA_VERSION) return;

    const legacyPets = settings.pets;
    if (legacyPets && (legacyPets.dog || legacyPets.cat) && !legacyPets.dog?.id && !legacyPets.cat?.id) {
        const migrated = {};
        for (const key of ['dog', 'cat']) {
            const p = legacyPets[key];
            if (!p) continue;
            const hasContent = [p.name, p.age, p.breed, p.size, p.likes, p.dislikes, p.habits, p.sound, p.energy, p.health, p.routine]
                .some((v) => (v || '').trim()) || (p.episodes && p.episodes.length);
            if (hasContent) {
                const id = generatePetId();
                migrated[id] = { id, species: key, ...p };
            }
        }
        settings.pets = migrated;
    }
    if (!settings.pets) settings.pets = {};
    if (!settings.activePetByCharacter) settings.activePetByCharacter = {};
    delete settings.activePet;

    const toArray = (v) => {
        if (Array.isArray(v)) return v;
        const s = (v || '').trim();
        return s ? [s] : [];
    };
    for (const id of Object.keys(settings.pets)) {
        const p = settings.pets[id];
        const mergedHabits = [...toArray(p.habits), ...toArray(p.routine)];
        settings.pets[id] = {
            id: p.id,
            species: p.species,
            name: p.name || '',
            age: p.age || '',
            breed: p.breed || '',
            gender: p.gender || '',
            size: p.size || '',
            energy: p.energy || '',
            likes: toArray(p.likes),
            dislikes: toArray(p.dislikes),
            habits: mergedHabits,
            sensitive: p.sensitive || p.health || '',
            episodes: p.episodes || [],
        };
    }
    if (settings.rainbowBridgeProfile === undefined) settings.rainbowBridgeProfile = '';

    settings.schemaVersion = SCHEMA_VERSION;
}

function getSettings() {
    const context = SillyTavern.getContext();

    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = context.extensionSettings[MODULE_NAME];
    migrateIfNeeded(settings);

    if (!settings.pets) settings.pets = {};
    for (const id of Object.keys(settings.pets)) {
        for (const field of Object.keys(EMPTY_PET_FIELDS)) {
            if (settings.pets[id][field] === undefined) {
                settings.pets[id][field] = structuredClone(EMPTY_PET_FIELDS[field]);
            }
        }
    }
    if (!settings.activePetByCharacter) settings.activePetByCharacter = {};
    if (!settings.tags) settings.tags = structuredClone(defaultSettings.tags);
    if (!Array.isArray(settings.tags.interaction)) settings.tags.interaction = structuredClone(defaultSettings.tags.interaction);
    if (!Array.isArray(settings.tags.routine)) settings.tags.routine = structuredClone(defaultSettings.tags.routine);
    if (!Array.isArray(settings.selectedTags)) settings.selectedTags = [];
    if (settings.customNote === undefined) settings.customNote = '';
    if (settings.oneShot === undefined) settings.oneShot = true;
    if (settings.rainbowBridgeProfile === undefined) settings.rainbowBridgeProfile = '';

    return settings;
}

// ---------- 캐릭터별 활성 펫 ----------

function getCharacterKey() {
    const context = SillyTavern.getContext();
    if (context.groupId) return `group:${context.groupId}`;
    const char = context.characters?.[context.characterId];
    if (char?.avatar) return `char:${char.avatar}`;
    if (context.name2) return `name:${context.name2}`;
    return 'unknown';
}

function getActivePetId() {
    const settings = getSettings();
    const id = settings.activePetByCharacter[getCharacterKey()];
    return id && settings.pets[id] ? id : null;
}

function setActivePetId(id) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    settings.activePetByCharacter[getCharacterKey()] = id;
    context.saveSettingsDebounced();
}

// ---------- 프롬프트 빌드 ----------

const rotationState = {};

function shuffle(arr) {
    return [...arr].sort(() => Math.random() - 0.5);
}

function pickRotating(stateKey, pool, n) {
    const cleanPool = (pool || []).map((x) => (x || '').trim()).filter(Boolean);
    if (cleanPool.length === 0) return [];

    const signature = cleanPool.join('§');
    let state = rotationState[stateKey];
    if (!state || state.signature !== signature) {
        state = rotationState[stateKey] = { queue: shuffle(cleanPool), signature };
    }

    const picked = [];
    for (let i = 0; i < n && i < cleanPool.length; i++) {
        if (state.queue.length === 0) {
            state.queue = shuffle(cleanPool);
        }
        picked.push(state.queue.pop());
    }
    return picked;
}

function collectBackgroundFacts(pet) {
    const facts = [];
    if (pet.age?.trim()) facts.push(`나이는 ${pet.age.trim()} 정도`);
    if (pet.breed?.trim()) facts.push(`${pet.breed.trim()} 종`);
    if (pet.gender) facts.push(pet.gender);
    if (pet.size?.trim()) facts.push(`${pet.size.trim()} 체구`);
    if (pet.energy?.trim()) facts.push(`평소 에너지는 ${pet.energy.trim()} 편`);
    (pet.likes || []).forEach((t) => t?.trim() && facts.push(`${t.trim()}을(를) 좋아함`));
    (pet.dislikes || []).forEach((t) => t?.trim() && facts.push(`${t.trim()}을(를) 싫어함`));
    (pet.habits || []).forEach((t) => t?.trim() && facts.push(t.trim()));
    return facts;
}

function buildInstructionText() {
    const settings = getSettings();
    const activeId = getActivePetId();
    if (!activeId) return '';

    const hasTags = settings.selectedTags && settings.selectedTags.length > 0;
    const hasNote = (settings.customNote || '').trim().length > 0;
    if (!hasTags && !hasNote) return '';

    const pet = settings.pets[activeId];
    const name = (pet.name || '').trim() || speciesLabel(pet.species);
    const facts = collectBackgroundFacts(pet);
    const episodes = pet.episodes || [];
    const pool = [...facts, ...episodes];
    const picked = pickRotating(activeId, pool, 2);

    const lines = [
        '[반려동물 등장 지시 — 시스템]',
        `지금 새로 작성할 응답 한 번에만, "${name}"(${speciesLabel(pet.species)})이 자연스럽게 함께 있는 것으로 서술하라.`,
        '이 장면의 시간과 장소를 바꾸지 말고, 지금 이 순간 안에서만 자연스럽게 등장시켜라.',
    ];

    if (hasTags) {
        lines.push(`지금 반응 톤(참고용 키워드, 그대로 쓰지 말 것): ${settings.selectedTags.join(', ')}`);
    }
    if (picked.length) {
        lines.push(`참고 배경(은근히 반영, 그대로 옮기지 말 것): ${picked.join(' / ')}`);
    }
    if ((pet.sensitive || '').trim() && Math.random() < 0.25) {
        lines.push(`민감한 배경(아주 가끔만 참고, 조심스럽고 가볍게 스치듯 언급 가능 — 굳이 언급 안 해도 됨): ${pet.sensitive.trim()}`);
    }
    if (hasNote) {
        lines.push(`이번 장면 상황(참고용, 그대로 옮기지 말고 자연스럽게 녹여낼 것): ${settings.customNote.trim()}`);
    }

    lines.push(
        '금지 사항:',
        '- 나이·품종·병명 등 사실 단어를 문장에 직접 쓰지 말 것.',
        '- 위 반응 톤 단어를 그대로 감정 서술어로 쓰지 말 것 (예: "질투하며", "애교부리듯").',
        '- 배경 정보나 상황 문장을 나열하거나 요약해서 설명하지 말 것.',
        '- 이 지시문의 존재를 언급하거나, 다른 메모·OOC와 연결짓지 말 것.',
        '- 이 지시는 오직 지금 새로 작성하는 이번 응답 한 번에만 적용된다. 이전 응답이나 과거 장면을 다시 쓰거나 요약하거나 수정하지 말 것.',
        '- 시간을 앞으로 건너뛰거나(예: "잠시 후", "그날 저녁") 장면을 전환하지 말 것. 지금 진행 중인 순간에서 그대로 이어서 서술할 것.',
        '나쁜 예 (금지): "신부전을 앓는 15살 슈나우저 믹스가 질투하며 다가왔다"',
        '좋은 예 (허용): "작은 발소리가 들리더니, 말없이 다가와 발치에 몸을 기댔다"',
        '위 좋은 예처럼, 정보에서 우러나온 짧고 구체적인 행동 하나만 자연스럽게 녹여내라.',
        '장면 속 캐릭터나 사용자 페르소나가 이 행동에 짧게 반응하거나 상호작용해도 좋다. 다만 매번 그럴 필요는 없고, 넣더라도 한두 문장 이내로 자연스럽게.',
    );

    return lines.join('\n');
}

function updateExtensionPrompt() {
    const context = SillyTavern.getContext();
    const text = buildInstructionText();
    const { types, roles } = getPromptConstants();

    context.setExtensionPrompt(
        PROMPT_KEY,
        text,
        types.IN_CHAT,
        0,
        false,
        roles.SYSTEM,
    );
}

// ---------- 입력창 옆 단일 버튼 ----------

function updateButtonUI() {
    const settings = getSettings();
    const $btn = $('#pet_summon_active');
    if (!$btn.length) return;

    const activeId = getActivePetId();
    const pet = activeId ? settings.pets[activeId] : null;
    const $icon = $btn.find('.ps-btn-icon');
    $icon.attr('class', 'ps-btn-icon fa-solid');

    if (pet) {
        $icon.addClass(pet.species === 'cat' ? 'fa-cat' : 'fa-dog');
        $btn.attr('title', `${(pet.name || '').trim() || speciesLabel(pet.species)} · 클릭해서 반응 방식 선택`);
    } else {
        $icon.addClass('fa-paw');
        $btn.attr('title', '마법봉 메뉴의 "천사에게"에서 이 캐릭터에 쓸 반려동물을 먼저 선택하세요');
    }

    const armed = !!((settings.selectedTags && settings.selectedTags.length) || (settings.customNote || '').trim());
    $btn.toggleClass('armed', armed);
}

function clearArmed() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    settings.selectedTags = [];
    settings.customNote = '';
    updateExtensionPrompt();
    updateButtonUI();
    context.saveSettingsDebounced();
    toastr.info('적용이 취소되었습니다.', '천사에게');
}

function injectButtons() {
    if ($('#pet_summon_active').length) return;

    const $btn = $('<div id="pet_summon_active" class="pet-summon-btn interactable" tabindex="0"></div>');
    const $icon = $('<i class="ps-btn-icon fa-solid fa-paw"></i>');
    const $cancel = $('<span class="ps-cancel-badge" title="적용 취소"></span>');
    $btn.append($icon).append($cancel);

    $btn.on('click', function (e) {
        e.preventDefault(); 
        if ($(e.target).closest('.ps-cancel-badge').length) {
            clearArmed();
        } else {
            openTagPopup();
        }
    });

    if ($('#rightSendForm').length) {
        $('#rightSendForm').prepend($btn);
    } else if ($('#send_form').length) {
        $('#send_form').prepend($btn);
    } else {
        console.warn('[PetSummoner] 입력창 영역을 찾지 못해 버튼을 추가하지 못했습니다.');
        return;
    }

    updateButtonUI();
}

// ---------- 태그 선택 팝업 (커스텀 모달) ----------

function closeTagPopup() {
    document.getElementById('ps_tag_overlay')?.remove();
}

function openTagPopup() {
    const settings = getSettings();
    const activeId = getActivePetId();

    if (!activeId) {
        toastr.warning('마법봉 메뉴의 "천사에게"에서 이 캐릭터에 쓸 반려동물을 먼저 선택해주세요.', '천사에게');
        return;
    }
    const stale = document.getElementById('ps_tag_overlay');
    if (stale) stale.remove();

    try {
        const mobile = isMobile();
        const pet = settings.pets[activeId];
        const name = (pet.name || '').trim() || speciesLabel(pet.species);
        const icon = pet.species === 'cat' ? 'fa-cat' : 'fa-dog';
        const selected = new Set(settings.selectedTags || []);

        function renderGroup(list) {
            return list.map((tag) => {
                const cls = selected.has(tag) ? 'petsum-pill active' : 'petsum-pill';
                return `<span class="${cls}" data-tag="${escapeAttr(tag)}">${escapeHtml(tag)}</span>`;
            }).join('');
        }

        const overlay = document.createElement('div');
        overlay.id = 'ps_tag_overlay';
        overlay.className = `ps-overlay ${mobile ? 'ps-mobile' : 'ps-desktop'}`;

        const box = document.createElement('div');
        box.id = 'ps_tag_box';
        box.className = `ps-box ${mobile ? 'ps-mobile' : 'ps-desktop-sm'}`;
        box.innerHTML = `
            <div class="ps-modal-body">
                ${mobile ? '<div class="ps-sheet-handle"></div>' : ''}
                <div class="ps-tagpopup-header"><i class="fa-solid ${icon}"></i>${escapeHtml(name)}이(가) 지금 어떻게 반응할까요</div>
                <p class="ps-tagpopup-label">상호작용 방식</p>
                <div class="ps-pill-row">${renderGroup(settings.tags.interaction)}</div>
                <p class="ps-tagpopup-label">함께하는 루틴</p>
                <div class="ps-pill-row">${renderGroup(settings.tags.routine)}</div>
                <p class="ps-tagpopup-hint">루틴 태그는 지금 장면과 맞을 때만 선택하세요 (예: 실내 대화 중엔 산책하기보다 곁에 있어주기).</p>
                <p class="ps-tagpopup-label">직접 입력 (선택)</p>
                <textarea id="ps_tag_custom" class="ps-tagpopup-input" rows="1" placeholder="예: 산책시킨다"></textarea>
                <p class="ps-tagpopup-hint">태그·문장은 그대로 옮겨지지 않고, 참고해서 자연스럽게 반영돼요.</p>
            </div>
            <div class="ps-modal-footer">
                <button type="button" class="ps-btn-ghost" id="ps_tag_cancel">취소</button>
                <button type="button" class="ps-btn-solid" id="ps_tag_apply">적용</button>
            </div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        box.querySelector('#ps_tag_custom').value = settings.customNote || '';

        box.querySelectorAll('.petsum-pill').forEach((el) => {
            addTapListener(el, () => {
                const tag = el.getAttribute('data-tag');
                el.classList.toggle('active');
                if (selected.has(tag)) selected.delete(tag); else selected.add(tag);
            });
        });

        addTapListener(overlay, (e) => {
            if (e.target === overlay) closeTagPopup();
        });
        // Peach Whisper 방식의 오버레이 닫기 적용
        overlay.addEventListener('touchstart', (e) => {
            if (e.target === overlay) closeTagPopup();
        }, { passive: true });

        addTapListener(box.querySelector('#ps_tag_cancel'), closeTagPopup);
        addTapListener(box.querySelector('#ps_tag_apply'), () => {
            const context = SillyTavern.getContext();
            settings.selectedTags = Array.from(selected);
            settings.customNote = box.querySelector('#ps_tag_custom').value;
            updateExtensionPrompt();
            updateButtonUI();
            context.saveSettingsDebounced();
            if (settings.selectedTags.length || settings.customNote.trim()) {
                toastr.info('다음 응답에 반영됩니다.', '천사에게');
            }
            closeTagPopup();
        });
    } catch (error) {
        console.error('[PetSummoner] 태그 팝업을 여는 데 실패했습니다:', error);
        document.getElementById('ps_tag_overlay')?.remove();
        toastr.error('태그 창을 여는 데 실패했어요. 콘솔(F12)을 확인해주세요.', '천사에게');
    }
}

// ---------- 마법봉 메뉴 항목 ----------

function injectMenuItem() {
    if ($('#pet_summoner_menu_item').length) return;

    const $item = $(
        '<div id="pet_summoner_menu_item" class="list-group-item flex-container flexGap5 interactable" tabindex="0">' +
        '<i class="fa-solid fa-paw"></i><span>천사에게</span></div>'
    );

    $item.on('click', function (e) {
        e.preventDefault();
        openMainPanel();
    });

    const $menu = $('#extensionsMenu');
    if ($menu.length) {
        $menu.append($item);
    } else {
        console.warn('[PetSummoner] 확장 메뉴(#extensionsMenu)를 찾지 못했습니다.');
    }
}

// ---------- 메인 패널 내비게이션 ----------

function getScreenStack() {
    const box = document.getElementById('ps_main_box');
    if (!box) return ['home'];
    try {
        const stack = JSON.parse(box.dataset.screenStack || '["home"]');
        return Array.isArray(stack) && stack.length ? stack : ['home'];
    } catch {
        return ['home'];
    }
}

function setScreenStack(stack) {
    const box = document.getElementById('ps_main_box');
    if (box) box.dataset.screenStack = JSON.stringify(stack);
}

function getRainbowSelectedPetId() {
    return document.getElementById('ps_main_box')?.dataset.rainbowPetId || null;
}

function setRainbowSelectedPetId(id) {
    const box = document.getElementById('ps_main_box');
    if (box) box.dataset.rainbowPetId = id || '';
}

function currentTopScreen() {
    const stack = getScreenStack();
    return stack[stack.length - 1] || 'home';
}

function pushScreen(screen) {
    const stack = getScreenStack();
    stack.push(screen);
    setScreenStack(stack);
    renderScreen(screen);
}

function popScreen() {
    const stack = getScreenStack();
    if (stack.length > 1) {
        stack.pop();
        setScreenStack(stack);
        renderScreen(currentTopScreen());
    }
}

function updateModalHeader(screen) {
    const titles = {
        home: '천사에게',
        dogs: '강아지',
        cats: '고양이',
        tags: '태그',
        'rainbow-pick': '무지개다리',
        'rainbow-diary': '무지개다리',
    };
    $('#ps_main_title').text(titles[screen] || '천사에게');
    $('#ps_main_back').toggle(screen !== 'home');
}

function closeMainPanel() {
    unbindPanelEvents();
    document.getElementById('ps_main_overlay')?.remove();
}

async function openMainPanel() {
    const stale = document.getElementById('ps_main_overlay');
    if (stale) {
        unbindPanelEvents();
        stale.remove();
    }

    try {
        const mobile = isMobile();

        const overlay = document.createElement('div');
        overlay.id = 'ps_main_overlay';
        overlay.className = `ps-overlay ${mobile ? 'ps-mobile' : 'ps-desktop'}`;

        const box = document.createElement('div');
        box.id = 'ps_main_box';
        box.className = `ps-box ${mobile ? 'ps-mobile' : 'ps-desktop'}`;
        box.innerHTML = `
            <div class="ps-modal-header">
                <i class="fa-solid fa-chevron-left ps-modal-back" id="ps_main_back" style="display:none"></i>
                <div class="ps-modal-header-icon"><i class="fa-solid fa-paw"></i></div>
                <span class="ps-modal-title" id="ps_main_title">천사에게</span>
                <i class="fa-solid fa-xmark ps-modal-close" id="ps_main_close"></i>
            </div>
            ${mobile ? '<div class="ps-sheet-handle"></div>' : ''}
            <div class="ps-modal-body" id="ps_main_body"></div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        addTapListener(overlay, (e) => {
            if (e.target === overlay) closeMainPanel();
        });
        // Peach Whisper 방식의 오버레이 닫기 적용
        overlay.addEventListener('touchstart', (e) => {
            if (e.target === overlay) closeMainPanel();
        }, { passive: true });

        addTapListener(box.querySelector('#ps_main_close'), closeMainPanel);

        bindPanelEvents();
        box.dataset.screenStack = JSON.stringify(['home']);
        box.dataset.rainbowPetId = '';
        renderScreen('home');
    } catch (error) {
        console.error('[PetSummoner] 메인 패널을 여는 데 실패했습니다:', error);
        document.getElementById('ps_main_overlay')?.remove();
        toastr.error('패널을 여는 데 실패했어요. 콘솔(F12)을 확인해주세요.', '천사에게');
    }
}

function renderScreen(screen) {
    const $body = $('#ps_main_body');
    if (!$body.length) return;
    updateModalHeader(screen);

    if (screen === 'home') {
        $body.html(homeScreenHtml());
        return;
    }

    if (screen === 'dogs' || screen === 'cats') {
        const species = screen === 'dogs' ? 'dog' : 'cat';
        $body.html(petListScreenHtml(species));
        const settings = getSettings();
        Object.keys(settings.pets).filter((id) => settings.pets[id].species === species).forEach((id) => {
            $(`select.ps-pet-field[data-pet-id="${id}"][data-field="energy"]`).val(settings.pets[id].energy || '');
            $(`select.ps-pet-field[data-pet-id="${id}"][data-field="gender"]`).val(settings.pets[id].gender || '');
            renderEpisodesFor(id);
        });
        return;
    }

    if (screen === 'tags') {
        $body.html(tagsScreenHtml());
        renderTagManager('interaction');
        renderTagManager('routine');
        return;
    }

    if (screen === 'rainbow-pick') {
        $body.html(rainbowPickScreenHtml());
        return;
    }

    if (screen === 'rainbow-diary') {
        const settings = getSettings();
        const pet = settings.pets[getRainbowSelectedPetId()];
        if (!pet) {
            popScreen();
            return;
        }
        $body.html(rainbowDiaryScreenHtml(pet));
        populateProfileSelect();
    }
}

// ---------- 화면 HTML 빌더 ----------

function homeScreenHtml() {
    const settings = getSettings();
    const dogCount = Object.values(settings.pets).filter((p) => p.species === 'dog').length;
    const catCount = Object.values(settings.pets).filter((p) => p.species === 'cat').length;

    return `
        <div class="ps-menu-row" data-nav="dogs">
            <div class="ps-menu-icon"><i class="fa-solid fa-dog"></i></div>
            <div class="ps-menu-text"><p class="ps-menu-title">강아지</p><p class="ps-menu-sub">${dogCount}마리 저장됨</p></div>
            <i class="fa-solid fa-chevron-right ps-menu-chevron"></i>
        </div>
        <div class="ps-menu-row" data-nav="cats">
            <div class="ps-menu-icon"><i class="fa-solid fa-cat"></i></div>
            <div class="ps-menu-text"><p class="ps-menu-title">고양이</p><p class="ps-menu-sub">${catCount}마리 저장됨</p></div>
            <i class="fa-solid fa-chevron-right ps-menu-chevron"></i>
        </div>
        <div class="ps-menu-row" data-nav="tags">
            <div class="ps-menu-icon"><i class="fa-solid fa-tag"></i></div>
            <div class="ps-menu-text"><p class="ps-menu-title">태그</p><p class="ps-menu-sub">상호작용 · 루틴 관리</p></div>
            <i class="fa-solid fa-chevron-right ps-menu-chevron"></i>
        </div>
        <div class="ps-menu-row ps-menu-row-warm" data-nav="rainbow-pick">
            <div class="ps-menu-icon ps-menu-icon-warm"><i class="fa-solid fa-rainbow"></i></div>
            <div class="ps-menu-text"><p class="ps-menu-title">무지개다리</p><p class="ps-menu-sub">떠난 아이에게 짧은 인사</p></div>
            <i class="fa-solid fa-chevron-right ps-menu-chevron"></i>
        </div>

        <div class="ps-row-toggle">
            <span>입력창 버튼에서 태그 적용 후, 응답 1회만 반영하고 자동 해제</span>
            <label class="ps-toggle">
                <input type="checkbox" id="ps_oneshot" ${settings.oneShot ? 'checked' : ''} />
                <span class="ps-toggle-track"></span>
            </label>
        </div>

        <button id="ps_reset_all" class="ps-btn-reset" type="button">전체 초기화</button>
    `;
}

function tagPillsHtml(petId, field, items) {
    return (items || []).map((t) => (
        `<span class="petsum-pill ps-pet-tag-pill" data-pet-id="${petId}" data-field="${field}" data-tag="${escapeAttr(t)}">${escapeHtml(t)} <i class="fa-solid fa-xmark ps-pet-tag-remove"></i></span>`
    )).join('');
}

function tagListHtml(petId, field, items) {
    return `<div class="ps-pill-row" data-pet-id="${petId}" data-field="${field}">${tagPillsHtml(petId, field, items)}</div><input type="text" class="text_pole ps-pet-tag-input" data-pet-id="${petId}" data-field="${field}" placeholder="+ 입력 후 Enter" />`;
}

function refreshPetTagPills(petId, field) {
    const settings = getSettings();
    const pet = settings.pets[petId];
    if (!pet) return;
    const $row = $(`.ps-pill-row[data-pet-id="${petId}"][data-field="${field}"]`);
    if ($row.length) $row.html(tagPillsHtml(petId, field, pet[field]));
}

function petCardHtml(pet, activeId) {
    const icon = pet.species === 'cat' ? 'fa-cat' : 'fa-dog';
    const isActive = pet.id === activeId;
    const title = escapeHtml((pet.name || '').trim() || speciesLabel(pet.species));

    return `
    <div class="ps-card" data-pet-id="${pet.id}">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header ps-head">
                <i class="fa-solid ${icon}"></i>
                <span class="ps-head-title">${title}</span>
                <label class="ps-active-radio">
                    <input type="radio" name="ps_active_pet_radio" class="ps-pet-activate" data-pet-id="${pet.id}" ${isActive ? 'checked' : ''} /> 이 캐릭터
                </label>
                <i class="fa-solid fa-trash ps-pet-delete" data-pet-id="${pet.id}" title="라이브러리에서 삭제"></i>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content ps-fields" style="display:none;">
                <div class="ps-grid2">
                    <div class="ps-field"><label>이름</label><input type="text" class="text_pole ps-pet-field" data-pet-id="${pet.id}" data-field="name" value="${escapeAttr(pet.name)}" placeholder="예: 윌리엄" /></div>
                    <div class="ps-field"><label>나이</label><input type="text" class="text_pole ps-pet-field" data-pet-id="${pet.id}" data-field="age" value="${escapeAttr(pet.age)}" placeholder="예: 7살" /></div>
                    <div class="ps-field"><label>품종</label><input type="text" class="text_pole ps-pet-field" data-pet-id="${pet.id}" data-field="breed" value="${escapeAttr(pet.breed)}" placeholder="선택 입력" /></div>
                    <div class="ps-field">
                        <label>성별</label>
                        <select class="text_pole ps-pet-field" data-pet-id="${pet.id}" data-field="gender">
                            <option value="">선택 안 함</option>
                            <option value="수컷">수컷</option>
                            <option value="암컷">암컷</option>
                        </select>
                    </div>
                    <div class="ps-field"><label>크기 · 체형</label><input type="text" class="text_pole ps-pet-field" data-pet-id="${pet.id}" data-field="size" value="${escapeAttr(pet.size)}" placeholder="선택 입력" /></div>
                    <div class="ps-field">
                        <label>에너지 레벨</label>
                        <select class="text_pole ps-pet-field" data-pet-id="${pet.id}" data-field="energy">
                            <option value="">선택 안 함</option>
                            <option value="차분함">차분함</option>
                            <option value="보통">보통</option>
                            <option value="활발함">활발함</option>
                            <option value="매우 활발함">매우 활발함</option>
                        </select>
                    </div>
                </div>
                <div class="ps-field">
                    <label>좋아하는 것</label>
                    ${tagListHtml(pet.id, 'likes', pet.likes)}
                </div>
                <div class="ps-field">
                    <label>싫어하는 것</label>
                    ${tagListHtml(pet.id, 'dislikes', pet.dislikes)}
                </div>
                <div class="ps-field">
                    <label>습관 · 루틴</label>
                    ${tagListHtml(pet.id, 'habits', pet.habits)}
                </div>
                <div class="ps-sensitive-box">
                    <div class="ps-sensitive-label"><i class="fa-solid fa-heart"></i> 민감정보 · 조심스럽게 다뤄짐</div>
                    <textarea class="ps-sensitive-input ps-pet-field" data-pet-id="${pet.id}" data-field="sensitive" rows="2" placeholder="예: 건강 상태 등 (선택 입력)">${escapeHtml(pet.sensitive)}</textarea>
                </div>
                <div class="ps-field">
                    <label>추억 에피소드</label>
                    <div class="ps-episode-list" data-pet-id="${pet.id}"></div>
                    <button class="ps-add-btn ps-episode-add" data-pet-id="${pet.id}" type="button"><i class="fa-solid fa-plus"></i> 추억 추가</button>
                </div>
            </div>
        </div>
    </div>`;
}

function petListScreenHtml(species) {
    const settings = getSettings();
    const activeId = getActivePetId();
    const ids = Object.keys(settings.pets)
        .filter((id) => settings.pets[id].species === species)
        .sort((a, b) => (settings.pets[a].name || '').localeCompare(settings.pets[b].name || ''));

    const listHtml = ids.length
        ? `<div class="ps-list-wrap">${ids.map((id) => petCardHtml(settings.pets[id], activeId)).join('')}</div>`
        : `<p class="ps-empty-hint">아직 등록된 ${speciesLabel(species)}가 없어요. 오른쪽 아래 + 버튼으로 추가해주세요.</p>`;

    return `${listHtml}<div class="ps-fab" id="ps_add_pet_fab" data-species="${species}"><i class="fa-solid fa-plus"></i></div>`;
}

function tagsScreenHtml() {
    return `
        <p class="ps-subtitle">상호작용 방식</p>
        <div id="ps_tagmgr_interaction" class="ps-pill-row"></div>
        <input id="ps_tagadd_interaction_input" type="text" class="text_pole ps-tag-add-input" placeholder="+ 태그 입력 후 Enter" />

        <p class="ps-subtitle" style="margin-top:16px">함께하는 루틴</p>
        <div id="ps_tagmgr_routine" class="ps-pill-row"></div>
        <input id="ps_tagadd_routine_input" type="text" class="text_pole ps-tag-add-input" placeholder="+ 태그 입력 후 Enter" />
    `;
}

function rainbowPickScreenHtml() {
    const settings = getSettings();
    const ids = Object.keys(settings.pets);
    if (!ids.length) {
        return '<p class="ps-empty-hint">아직 등록된 반려동물이 없어요. 강아지·고양이 화면에서 먼저 추가해주세요.</p>';
    }
    return ids.map((id) => {
        const pet = settings.pets[id];
        const icon = pet.species === 'cat' ? 'fa-cat' : 'fa-dog';
        const label = escapeHtml((pet.name || '').trim() || speciesLabel(pet.species));
        return `
            <div class="ps-menu-row ps-menu-row-warm ps-rainbow-pick-row" data-pet-id="${id}">
                <div class="ps-menu-icon ps-menu-icon-warm"><i class="fa-solid ${icon}"></i></div>
                <div class="ps-menu-text"><p class="ps-menu-title">${label}</p></div>
                <i class="fa-solid fa-chevron-right ps-menu-chevron"></i>
            </div>`;
    }).join('');
}

let rainbowChatLog = [];

function rainbowChatBubbleHtml(msg) {
    const cls = msg.role === 'user' ? 'ps-rainbow-chat-user' : 'ps-rainbow-chat-pet';
    return `<div class="ps-rainbow-chat-bubble ${cls}">${escapeHtml(msg.text)}</div>`;
}

function rainbowDiaryScreenHtml(pet) {
    const label = escapeHtml((pet.name || '').trim() || speciesLabel(pet.species));
    return `
        <div class="ps-rainbow-wrap">
            <div class="ps-rainbow-icon"><i class="fa-solid fa-rainbow"></i></div>
            <p class="ps-rainbow-title">${label}의 오늘</p>

            <div class="ps-rainbow-profile-row">
                <label class="ps-rainbow-profile-label">일기 · 대화 생성용 프로필</label>
                <select id="ps_rainbow_profile_select" class="ps-rainbow-select">
                    <option value="">메인 API 그대로 사용</option>
                </select>
            </div>

            <div id="ps_rainbow_diary_box" class="ps-rainbow-diary-box ps-rainbow-diary-empty">버튼을 눌러 오늘의 일기를 받아보세요.</div>

            <button id="ps_rainbow_generate_btn" class="ps-rainbow-btn" type="button" data-pet-id="${pet.id}">
                <i class="fa-solid fa-feather"></i> 새 일기 쓰기
            </button>

            <div class="ps-rainbow-chat-section">
                <label class="ps-rainbow-profile-label">하고 싶은 말 남기기</label>
                <div id="ps_rainbow_chat_log" class="ps-rainbow-chat-log">${rainbowChatLog.map(rainbowChatBubbleHtml).join('')}</div>
                <div class="ps-rainbow-chat-input-row">
                    <input type="text" id="ps_rainbow_chat_input" class="ps-rainbow-chat-input" placeholder="보고싶어, 잘 지내?" />
                    <button id="ps_rainbow_chat_send" class="ps-rainbow-chat-send" type="button" data-pet-id="${pet.id}"><i class="fa-solid fa-paper-plane"></i></button>
                </div>
            </div>
        </div>
    `;
}

// ---------- 펫 라이브러리 하위 렌더 ----------

function renderEpisodesFor(id) {
    const settings = getSettings();
    const pet = settings.pets[id];
    const $list = $(`.ps-episode-list[data-pet-id="${id}"]`);
    if (!$list.length || !pet) return;
    $list.empty();

    (pet.episodes || []).forEach((text, idx) => {
        const $row = $(
            `<div class="ps-episode-row" data-pet-id="${id}" data-index="${idx}">
                <i class="fa-solid fa-paw ps-episode-icon"></i>
                <textarea class="ps-episode-text" rows="1"></textarea>
                <i class="fa-solid fa-xmark ps-episode-remove" title="삭제"></i>
            </div>`,
        );
        $row.find('.ps-episode-text').val(text);
        $list.append($row);
    });
}

function renderTagManager(group) {
    const settings = getSettings();
    const $list = $(`#ps_tagmgr_${group}`);
    if (!$list.length) return;
    $list.empty();

    settings.tags[group].forEach((tag) => {
        const $pill = $(
            `<span class="petsum-pill petsum-pill-mgr" data-group="${group}" data-tag="${escapeAttr(tag)}">
                ${escapeHtml(tag)} <i class="fa-solid fa-xmark ps-tag-remove"></i>
            </span>`,
        );
        $list.append($pill);
    });
}

function addTagFromInput(group) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const $input = $(`#ps_tagadd_${group}_input`);
    const val = ($input.val() || '').trim();
    if (!val) return;
    if (!settings.tags[group].includes(val)) {
        settings.tags[group].push(val);
        renderTagManager(group);
        context.saveSettingsDebounced();
    }
    $input.val('');
}

// ---------- 무지개다리 일기 ----------

function buildRainbowPrompt(pet) {
    const name = (pet.name || '').trim() || speciesLabel(pet.species);
    const facts = [];
    if (pet.breed?.trim()) facts.push(`${pet.breed.trim()} 종`);
    if (pet.gender) facts.push(pet.gender);
    if ((pet.likes || []).length) facts.push(`좋아하는 것: ${pet.likes.join(', ')}`);
    if ((pet.habits || []).length) facts.push(`습관: ${pet.habits.join(', ')}`);
    const episodeLines = (pet.episodes || []).filter((e) => e && e.trim());

    return [
        '[중요 — 이 요청은 지금까지의 대화나 캐릭터 카드와 완전히 독립된 별도의 요청이다]',
        '캐릭터 카드, 이전 대화, 시스템 프롬프트에 어떤 출력 형식·번역 스키마·태그(예: 영어/한국어 이중 출력, <english_output>, <trans_korean>, <infoblock> 같은 것)가 지정되어 있더라도 절대 따르지 마라.',
        '오직 순수한 한국어 문장만 작성하고, 그 어떤 XML/HTML 태그, 메타데이터, 영어 병기도 포함하지 마라.',
        '',
        `당신은 지금 무지개다리 너머에 있는 반려동물 "${name}"입니다.`,
        '주인에게 편지 같은 일기를 1인칭으로, 순수 한국어 산문으로만 씁니다.',
        '',
        '[반려동물 정보 - 참고용, 나열하지 말고 자연스럽게 녹여쓸 것]',
        facts.join(' / ') || '(정보 없음)',
        '',
        '[추억 - 이 중 일부를 "함께한 추억 회상" 부분에 자연스럽게 녹여서 활용]',
        episodeLines.length ? episodeLines.join(' / ') : '(등록된 추억 없음)',
        '',
        '다음 다섯 가지 흐름을 순서대로, 하나의 자연스러운 편지글로 이어서 써줘. 각 항목의 예시 표현을 그대로 베끼지 말고, 이 아이만의 말투로 새로 풀어써줘.',
        '',
        '1. 안부와 평안함 — 아팠던 곳이 다 나았고 이제 자유롭게 뛰어다닌다는 안도감, 따뜻한 햇살과 들판, 새로 사귄 친구들 같은 이곳의 일상.',
        '2. 깊은 감사와 사랑 — 가족으로 맞아준 것에 대한 진심 어린 고마움, 함께했던 산책·품·다정한 목소리 같은 가장 아름다운 기억(위 [추억] 활용).',
        '3. 위로와 죄책감 덜어주기 — "더 잘해줄걸" 같은 자책·후회를 하지 말라는 위로, 너무 오래 슬퍼하지 말고 밥도 잘 챙겨 먹으며 다시 웃음을 찾았으면 하는 마음.',
        '4. 소소한 사과와 귀여운 회상 — 물건을 물어뜯거나 목욕 도망친 것 같은 귀여운 말썽에 대한 장난스러운 사과, 끝까지 곁을 지키지 못하고 먼저 떠난 것에 대한 미안함.',
        '5. 영원한 연결과 재회의 약속 — 보이지 않아도 바람처럼, 가끔 꿈처럼 늘 곁에서 지켜보겠다는 다짐, 주인이 아주 먼 훗날 이곳에 올 때 가장 먼저 마중 나가 꼬리를 흔들며 반기겠다는 약속.',
        '',
        '전체 톤: 슬픔보다는 따뜻함과 다정함이 앞서야 한다. 눈물을 강요하거나 무겁게 늘어지지 말고, 위로받는 느낌으로 끝나야 한다.',
        '길이: 14~20문장, 네다섯 문단으로 자연스럽게 이어지는 편지글.',
        '사람처럼 유식하게 말고, 그 아이만의 순수하고 사랑스러운 말투(짧은 문장, 느낌표, 의성어)로 생생하고 구체적인 장면 묘사를 섞어서 써줘.',
        '출력은 오직 일기 본문 텍스트만. 제목, 번호, 소제목, 태그, 설명은 전부 빼고 하나의 이어지는 글로.',
    ].join('\n');
}

function cleanDiaryText(raw) {
    let text = (raw || '').trim();
    if (!text) return text;

    const koreanBlock = text.match(/<trans_korean>([\s\S]*?)<\/trans_korean>/i);
    if (koreanBlock) {
        text = koreanBlock[1];
    } else {
        text = text.replace(/<english_output>[\s\S]*?<\/english_output>/gi, (block) => {
            const koreanParts = [...block.matchAll(/\(([^()]*[가-힣][^()]*)\)/g)].map((m) => m[1]);
            return koreanParts.join(' ');
        });
    }

    text = text.replace(/<infoblock>[\s\S]*?<\/infoblock>/gi, '');
    text = text.replace(/<\/?[a-zA-Z_][^>]*>/g, '');
    text = text.replace(/^(Date|Time|Weather|Vibe|Location|Pose|[A-Za-z]+\s?Outfit)::.*$/gim, '');
    text = text.replace(/^"|"$/g, '');

    return text.trim().replace(/\n{3,}/g, '\n\n');
}

async function populateProfileSelect() {
    const context = SillyTavern.getContext();
    const $select = $('#ps_rainbow_profile_select');
    if (!$select.length) return;

    const settings = getSettings();
    try {
        const result = await context.executeSlashCommandsWithOptions('/profile-list');
        const names = JSON.parse(result?.pipe || '[]');
        names.forEach((name) => {
            $select.append($('<option></option>').val(name).text(name));
        });
    } catch (error) {
        console.warn('[PetSummoner] 연결 프로필 목록을 불러오지 못했습니다:', error);
    }
    $select.val(settings.rainbowBridgeProfile || '');
}

async function generateRainbowDiary(petId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const pet = settings.pets[petId];
    if (!pet) return;

    const $box = $('#ps_rainbow_diary_box');
    const $btn = $('#ps_rainbow_generate_btn');
    $box.removeClass('ps-rainbow-diary-empty').text('일기를 쓰는 중...');
    $btn.prop('disabled', true);

    const profileName = ($('#ps_rainbow_profile_select').val() || '').trim();
    let originalProfile = '';
    let switched = false;

    try {
        if (profileName) {
            try {
                const cur = await context.executeSlashCommandsWithOptions('/profile');
                originalProfile = (cur?.pipe || '').trim();
            } catch (error) {
                console.warn('[PetSummoner] 현재 프로필 확인 실패:', error);
            }
            if (originalProfile && originalProfile !== profileName) {
                await context.executeSlashCommandsWithOptions(`/profile ${profileName}`);
                switched = true;
            }
        }

        const quietPrompt = buildRainbowPrompt(pet);
        const diaryText = await context.generateQuietPrompt({ quietPrompt });
        const cleaned = cleanDiaryText(diaryText);
        $box.text(cleaned || '일기를 받아오지 못했어요. 다시 시도해주세요.');
    } catch (error) {
        console.error('[PetSummoner] 무지개다리 일기 생성 실패:', error);
        $box.text('일기를 쓰는 데 실패했어요. 잠시 후 다시 시도해주세요.');
    } finally {
        if (switched && originalProfile) {
            try {
                await context.executeSlashCommandsWithOptions(`/profile ${originalProfile}`);
            } catch (error) {
                console.warn('[PetSummoner] 원래 프로필로 복귀하지 못했습니다:', error);
            }
        }
        $btn.prop('disabled', false);
    }
}

function scrollRainbowChatToBottom() {
    const el = document.getElementById('ps_rainbow_chat_log');
    if (el) el.scrollTop = el.scrollHeight;
}

function buildRainbowChatPrompt(pet, userMessage) {
    const name = (pet.name || '').trim() || speciesLabel(pet.species);
    const facts = [];
    if ((pet.likes || []).length) facts.push(`좋아하는 것: ${pet.likes.join(', ')}`);
    if ((pet.habits || []).length) facts.push(`습관: ${pet.habits.join(', ')}`);

    return [
        '[중요 — 캐릭터 카드나 이전 대화의 출력 형식·번역 스키마·태그를 절대 따르지 말고, 순수 한국어 문장만 출력하라]',
        `당신은 무지개다리 너머의 반려동물 "${name}"입니다.`,
        facts.length ? `[참고용, 그대로 나열하지 말 것] ${facts.join(' / ')}` : '',
        `주인이 방금 이렇게 말했습니다: "${userMessage}"`,
        '이 말에 자연스럽게, 그 아이다운 말투로 아주 짧게(1~2문장) 대답하라.',
        '밝고 다정하고 장난스럽게. 사람처럼 유식하게 말하지 말고, 순수하고 사랑스러운 반려동물 말투로.',
        '슬프거나 무겁게 답하지 말 것. 출력은 오직 대답 문장만, 따옴표나 태그 없이.',
    ].filter(Boolean).join('\n');
}

async function sendRainbowChat(petId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const pet = settings.pets[petId];
    const $input = $('#ps_rainbow_chat_input');
    const text = ($input.val() || '').trim();
    if (!text || !pet) return;

    rainbowChatLog.push({ role: 'user', text });
    $('#ps_rainbow_chat_log').append(rainbowChatBubbleHtml({ role: 'user', text }));
    $input.val('').prop('disabled', true);
    $('#ps_rainbow_chat_send').prop('disabled', true);

    const $typing = $('<div class="ps-rainbow-chat-bubble ps-rainbow-chat-pet ps-rainbow-chat-typing">...</div>');
    $('#ps_rainbow_chat_log').append($typing);
    scrollRainbowChatToBottom();

    const profileName = ($('#ps_rainbow_profile_select').val() || '').trim();
    let originalProfile = '';
    let switched = false;

    try {
        if (profileName) {
            try {
                const cur = await context.executeSlashCommandsWithOptions('/profile');
                originalProfile = (cur?.pipe || '').trim();
            } catch (error) {
                console.warn('[PetSummoner] 현재 프로필 확인 실패:', error);
            }
            if (originalProfile && originalProfile !== profileName) {
                await context.executeSlashCommandsWithOptions(`/profile ${profileName}`);
                switched = true;
            }
        }

        const quietPrompt = buildRainbowChatPrompt(pet, text);
        const reply = await context.generateQuietPrompt({ quietPrompt });
        const cleaned = cleanDiaryText(reply) || '...';
        rainbowChatLog.push({ role: 'pet', text: cleaned });
        $typing.removeClass('ps-rainbow-chat-typing').text(cleaned);
    } catch (error) {
        console.error('[PetSummoner] 무지개다리 대화 실패:', error);
        const fallback = '...잘 안 들렸나봐. 다시 말해줄래?';
        rainbowChatLog.push({ role: 'pet', text: fallback });
        $typing.removeClass('ps-rainbow-chat-typing').text(fallback);
    } finally {
        if (switched && originalProfile) {
            try {
                await context.executeSlashCommandsWithOptions(`/profile ${originalProfile}`);
            } catch (error) {
                console.warn('[PetSummoner] 원래 프로필로 복귀하지 못했습니다:', error);
            }
        }
        $input.prop('disabled', false);
        $('#ps_rainbow_chat_send').prop('disabled', false);
        scrollRainbowChatToBottom();
    }
}

// ---------- 패널 이벤트 바인딩 ----------

function bindPanelEvents() {
    unbindPanelEvents(); 

    const context = SillyTavern.getContext();
    const settings = getSettings();
    const ns = '.petsumPanel';

    bindTap('.ps-menu-row[data-nav]', function () {
        pushScreen($(this).data('nav'));
    }, ns);
    bindTap('#ps_main_back', function () {
        popScreen();
    }, ns);
    bindTap('.ps-rainbow-pick-row', function () {
        setRainbowSelectedPetId($(this).data('pet-id'));
        rainbowChatLog = [];
        pushScreen('rainbow-diary');
    }, ns);

    bindTap('#ps_add_pet_fab', function () {
        const species = $(this).data('species');
        const name = window.prompt(`${speciesLabel(species)} 이름을 입력해주세요`, '');
        if (name === null) return;
        const id = generatePetId();
        settings.pets[id] = { id, species, ...structuredClone(EMPTY_PET_FIELDS), name: name.trim() };
        context.saveSettingsDebounced();
        renderScreen(currentTopScreen());
    }, ns);

    $(document).on(`input${ns} change${ns}`, '.ps-pet-field', function () {
        const id = $(this).data('pet-id');
        const field = $(this).data('field');
        if (!settings.pets[id]) return;
        settings.pets[id][field] = $(this).val();
        if (field === 'name') {
            const label = ($(this).val() || '').trim() || speciesLabel(settings.pets[id].species);
            $(this).closest('.ps-card').find('.ps-head-title').text(label);
        }
        context.saveSettingsDebounced();
        if (id === getActivePetId()) updateButtonUI();
    });

    $(document).on(`keydown${ns}`, '.ps-pet-tag-input', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const id = $(this).data('pet-id');
        const field = $(this).data('field');
        const val = ($(this).val() || '').trim();
        if (!val || !settings.pets[id]) return;
        settings.pets[id][field] = settings.pets[id][field] || [];
        settings.pets[id][field].push(val);
        context.saveSettingsDebounced();
        refreshPetTagPills(id, field);
        $(this).val('');
    });
    bindTap('.ps-pet-tag-remove', function () {
        const $pill = $(this).closest('.ps-pet-tag-pill');
        const id = $pill.data('pet-id');
        const field = $pill.data('field');
        const tag = $pill.data('tag');
        if (!settings.pets[id]) return;
        settings.pets[id][field] = (settings.pets[id][field] || []).filter((t) => t !== tag);
        context.saveSettingsDebounced();
        refreshPetTagPills(id, field);
    }, ns);

    $(document).on(`change${ns}`, '.ps-pet-activate', function () {
        const id = $(this).data('pet-id');
        setActivePetId(id);
        updateExtensionPrompt();
        updateButtonUI();
    });
    bindTap('.ps-pet-delete', function (e) {
        e.stopPropagation();
        const id = $(this).data('pet-id');
        const pet = settings.pets[id];
        const label = pet ? ((pet.name || '').trim() || speciesLabel(pet.species)) : '이 반려동물';
        const confirmed = window.confirm(`"${label}"을(를) 라이브러리에서 삭제할까요? 이 펫을 활성화해둔 모든 캐릭터에서도 해제됩니다.`);
        if (!confirmed) return;

        delete settings.pets[id];
        for (const key of Object.keys(settings.activePetByCharacter)) {
            if (settings.activePetByCharacter[key] === id) {
                delete settings.activePetByCharacter[key];
            }
        }
        updateExtensionPrompt();
        updateButtonUI();
        context.saveSettingsDebounced();
        renderScreen(currentTopScreen());
    }, ns);
    $(document).on(`click${ns}`, '.ps-active-radio, .ps-pet-delete', function (e) {
        e.stopPropagation();
    });

    bindTap('.ps-episode-add', function () {
        const id = $(this).data('pet-id');
        settings.pets[id].episodes = settings.pets[id].episodes || [];
        settings.pets[id].episodes.push('');
        renderEpisodesFor(id);
        context.saveSettingsDebounced();
    }, ns);
    $(document).on(`input${ns}`, '.ps-episode-text', function () {
        const $row = $(this).closest('.ps-episode-row');
        const id = $row.data('pet-id');
        const idx = $row.data('index');
        settings.pets[id].episodes[idx] = $(this).val();
        context.saveSettingsDebounced();
    });
    bindTap('.ps-episode-remove', function () {
        const $row = $(this).closest('.ps-episode-row');
        const id = $row.data('pet-id');
        const idx = $row.data('index');
        settings.pets[id].episodes.splice(idx, 1);
        renderEpisodesFor(id);
        context.saveSettingsDebounced();
    }, ns);

    for (const group of ['interaction', 'routine']) {
        $(document).on(`keydown${ns}`, `#ps_tagadd_${group}_input`, function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addTagFromInput(group);
            }
        });
        $(document).on(`blur${ns}`, `#ps_tagadd_${group}_input`, function () {
            addTagFromInput(group);
        });
    }
    bindTap('.ps-tag-remove', function (e) {
        e.stopPropagation();
        const $pill = $(this).closest('.petsum-pill-mgr');
        const group = $pill.data('group');
        const tag = $pill.data('tag');
        settings.tags[group] = settings.tags[group].filter((t) => t !== tag);
        renderTagManager(group);
        context.saveSettingsDebounced();
    }, ns);

    $(document).on(`change${ns}`, '#ps_rainbow_profile_select', function () {
        settings.rainbowBridgeProfile = $(this).val();
        context.saveSettingsDebounced();
    });
    bindTap('#ps_rainbow_generate_btn', function () {
        generateRainbowDiary($(this).data('pet-id'));
    }, ns);
    bindTap('#ps_rainbow_chat_send', function () {
        sendRainbowChat($(this).data('pet-id'));
    }, ns);
    $(document).on(`keydown${ns}`, '#ps_rainbow_chat_input', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendRainbowChat(getRainbowSelectedPetId());
        }
    });

    $(document).on(`change${ns}`, '#ps_oneshot', function () {
        settings.oneShot = $(this).is(':checked');
        context.saveSettingsDebounced();
    });
    bindTap('#ps_reset_all', function () {
        const confirmed = window.confirm('모든 반려동물 정보와 태그가 초기화됩니다. 계속할까요?');
        if (!confirmed) return;

        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
        context.saveSettingsDebounced();
        updateExtensionPrompt();
        updateButtonUI();
        renderScreen('home');
        toastr.info('초기화되었습니다.', '천사에게');
    }, ns);
}

function unbindPanelEvents() {
    $(document).off('.petsumPanel');
}

// ---------- 1회성 초기화 ----------

function resetOneShotIfNeeded() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.oneShot) return;

    const hasTags = settings.selectedTags && settings.selectedTags.length > 0;
    const hasNote = (settings.customNote || '').trim().length > 0;
    if (!hasTags && !hasNote) return;

    settings.selectedTags = [];
    settings.customNote = '';
    updateExtensionPrompt();
    updateButtonUI();
    context.saveSettingsDebounced();
}

function registerSlashCommand() {
    try {
        const ctx = SillyTavern.getContext();
        const SlashCommandParser = ctx.SlashCommandParser;
        const SlashCommand = ctx.SlashCommand;
        if (!SlashCommandParser || !SlashCommand) {
            console.warn('[PetSummoner] SlashCommand API를 찾지 못해 /petsummon 명령어는 건너뜁니다.');
            return;
        }
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'petsummon',
            callback: () => {
                openTagPopup();
                return '';
            },
            helpString: '입력창 옆 소환 버튼을 누른 것과 동일하게, 지금 캐릭터에 활성화된 반려동물의 태그 선택 팝업을 엽니다. 빠른 응답(Quick Reply)에서 <code>/petsummon</code>으로 호출할 수 있습니다.',
        }));
    } catch (error) {
        console.warn('[PetSummoner] /petsummon 명령어 등록 실패(무시하고 계속):', error);
    }
}

// ---------- 초기화 ----------

function safeInjectAll() {
    try {
        injectButtons();
    } catch (error) {
        console.error('[PetSummoner] injectButtons 실패:', error);
    }
    try {
        injectMenuItem();
    } catch (error) {
        console.error('[PetSummoner] injectMenuItem 실패:', error);
    }
}

function boot(attemptsLeft = 20) {
    let context;
    try {
        context = SillyTavern.getContext();
        if (!context || !context.eventSource || !context.event_types) {
            throw new Error('context가 아직 준비되지 않음');
        }
    } catch (error) {
        if (attemptsLeft > 0) {
            setTimeout(() => boot(attemptsLeft - 1), 500);
        } else {
            console.error('[PetSummoner] SillyTavern 컨텍스트를 끝내 가져오지 못했습니다:', error);
        }
        return;
    }

    context.eventSource.on(context.event_types.APP_READY, () => {
        safeInjectAll();
        try { updateExtensionPrompt(); } catch (error) { console.error('[PetSummoner] updateExtensionPrompt 실패:', error); }
        try { updateButtonUI(); } catch (error) { console.error('[PetSummoner] updateButtonUI 실패:', error); }
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        safeInjectAll();
        try { updateExtensionPrompt(); } catch (error) { console.error('[PetSummoner] updateExtensionPrompt 실패:', error); }
        try { updateButtonUI(); } catch (error) { console.error('[PetSummoner] updateButtonUI 실패:', error); }
    });

    context.eventSource.on(context.event_types.GENERATION_ENDED, resetOneShotIfNeeded);
    context.eventSource.on(context.event_types.GENERATION_STOPPED, resetOneShotIfNeeded);

    bindTap('#extensionsMenuButton', () => {
        setTimeout(() => {
            try { injectMenuItem(); } catch (error) { console.error('[PetSummoner] injectMenuItem 실패:', error); }
        }, 50);
    });

    safeInjectAll();
    registerSlashCommand();
    try {
        updateExtensionPrompt();
    } catch (error) {
        console.error('[PetSummoner] updateExtensionPrompt 실패:', error);
    }

    setTimeout(safeInjectAll, 2000);
    console.log('[PetSummoner] 확장이 로드되었습니다.');
}

jQuery(() => {
    boot();
});
