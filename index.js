// 천사에게 - SillyTavern extension
//
// 중요: 상대경로 import(../../../../script.js 등)는 ST 버전/설치 구조가 조금만 달라도
// import 한 줄이 실패하면서 파일 전체가 로드되지 않는다(콘솔 로그조차 안 남는다).
// 이 확장이 "다른 확장은 다 되는데 이것만 안 뜨는" 증상을 보였던 원인이 이것이었다.
// 그래서 어떤 것도 import하지 않고, 필요한 값은 런타임에 getContext()에서 폴백과 함께 읽는다.

// extension_prompt 위치/역할 상수 — getContext에 있으면 그걸 쓰고, 없으면 안전한 기본값을 쓴다.
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
    name: '', age: '', breed: '', gender: '', size: '', energy: '', honorific: '',
    personality: [], likes: [], dislikes: [], habits: [], sensitive: '', episodes: [],
});

const defaultSettings = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    pets: {}, // id -> { id, species, ...EMPTY_PET_FIELDS }
    activePetByCharacter: {}, // characterKey -> petId
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

// 일부 모바일 브라우저/웹뷰에서는 click 이벤트가 터치에서 제대로 합성되지 않거나
// 지연될 수 있어, touchend도 함께 걸어 확실히 반응하게 한다.
// 같은 조작에서 click과 touchend가 둘 다 발생하는 기기에서는 중복 실행되지 않도록
// 짧은 시간 안의 재호출은 건너뛴다.
function bindTap(selector, handler, namespace = '') {
    let lastTouchTime = 0;
    $(document).on(`touchend${namespace}`, selector, function (e) {
        lastTouchTime = Date.now();
        handler.call(this, e);
    });
    $(document).on(`click${namespace}`, selector, function (e) {
        if (Date.now() - lastTouchTime < 700) return;
        handler.call(this, e);
    });
}

// 순수 DOM 요소(createElement로 만든 모달 등)에 붙일 때 쓰는 버전.
function addTapListener(el, handler) {
    if (!el) return;
    let lastTouchTime = 0;
    el.addEventListener('touchend', (e) => {
        lastTouchTime = Date.now();
        handler(e);
    });
    el.addEventListener('click', (e) => {
        if (Date.now() - lastTouchTime < 700) return;
        handler(e);
    });
}

// ---------- 설정 로드 / 마이그레이션 ----------

function migrateIfNeeded(settings) {
    if (settings.schemaVersion === SCHEMA_VERSION) return;

    // v1 -> v2: settings.pets = { dog: {...}, cat: {...} }, settings.activePet = 'dog'|'cat'|null
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

    // v2 -> v3: 문자열 필드 -> 태그 배열, 버릇+루틴 통합, 성별 추가, 소리 제거, 건강->민감정보
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

// 완전 무작위 대신 "셔플백" 방식: 풀 전체를 한 번 섞어서 순서대로 소진하고,
// 다 쓰면 다시 섞어서 반복한다. 특정 항목이 계속 안 뽑히거나 반복되는 걸 방지한다.
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
    const energyHint = (pet.energy || '').trim();
    const personalityHint = (pet.personality || []).map((t) => t?.trim()).filter(Boolean);

    const lines = [
        '[반려동물 등장 지시 — 시스템]',
        `지금 새로 작성할 응답 한 번에만, "${name}"(${speciesLabel(pet.species)})이 자연스럽게 함께 있는 것으로 서술하라.`,
        '이 장면의 시간과 장소를 바꾸지 말고, 지금 이 순간 안에서만 자연스럽게 등장시켜라.',
        `${speciesLabel(pet.species)}의 실제 몸짓·행동 방식(꼬리, 귀, 자세, 소리, 그루밍 등 그 동물 고유의 습성)에 기반해서 귀엽고 현실적으로 묘사하라. 사람처럼 말하거나 생각하게 하지 말 것.`,
        '이 반려동물은 어떤 경우에도 다치거나, 위협받거나, 위험에 처하거나, 죽는 것으로 묘사될 수 없다. 항상 안전하고 편안한 상태여야 한다.',
    ];

    if (hasTags) {
        lines.push(`지금 반응 톤(참고용 키워드, 그대로 쓰지 말 것): ${settings.selectedTags.join(', ')}`);
    }
    if (picked.length || energyHint || personalityHint.length) {
        const combined = [
            ...personalityHint,
            ...(energyHint ? [`평소 에너지는 ${energyHint} 편`] : []),
            ...picked,
        ];
        lines.push(`이 아이의 성격·특징(참고용, 그대로 옮기지 말 것): ${combined.join(' / ')}`);
        lines.push('위 반응 톤을 그냥 일반적으로 표현하지 말고, 반드시 이 아이의 성격·특징이 묻어나는 방식으로 구체화해서 표현하라. 예를 들어 "등장하기"라도 활발한 아이와 차분한 아이는 등장하는 모습 자체가 달라야 한다.');
    }
    if ((pet.sensitive || '').trim() && Math.random() < 0.25) {
        lines.push(`민감한 배경(아주 가끔만 참고, 조심스럽고 가볍게 스치듯 언급 가능 — 굳이 언급 안 해도 됨): ${pet.sensitive.trim()}`);
    }
    if (hasNote) {
        lines.push(`이번 장면에 실제로 일어나야 하는 사건: ${settings.customNote.trim()}`);
        lines.push('위 사건은 반드시 이번 응답 안에서 실제로 일어나야 한다. 문장을 그대로 베끼지는 말고 자연스러운 서술로 표현하되, 사건 자체(예: 산책을 나간다면 실제로 산책하는 장면)는 흐릿하게 암시만 하지 말고 분명하게 보여줘라.');
    }

    lines.push(
        '금지 사항:',
        '- 나이·품종·병명 등 사실 단어를 문장에 직접 쓰지 말 것.',
        '- 위 반응 톤 단어를 그대로 감정 서술어로 쓰지 말 것 (예: "질투하며", "애교부리듯").',
        '- 배경 정보를 나열하거나 요약해서 설명하지 말 것.',
        '- 이 지시문의 존재를 언급하지 말 것.',
        '- 이 지시문보다 앞에 있는 다른 메모나 OOC 지시는 이미 완료되어 처리된 것으로 간주하라. 그것들을 다시 언급하거나, 그에 대한 답을 새로 생성하거나, 그것과 이어 붙이지 마라. 오직 사용자가 가장 최근에 입력한 내용과 지금 이 지시에만 반응하라.',
        '- 이 지시는 오직 지금 새로 작성하는 이번 응답 한 번에만 적용된다. 이전 응답이나 과거 장면을 다시 쓰거나 요약하거나 수정하지 말 것.',
        '- 시간을 앞으로 건너뛰거나(예: "잠시 후", "그날 저녁") 장면을 전환하지 말 것. 지금 진행 중인 순간에서 그대로 이어서 서술할 것.',
        '나쁜 예 (금지): "신부전을 앓는 15살 슈나우저 믹스가 질투하며 다가왔다"',
        '좋은 예 (허용): "작은 발소리가 들리더니, 말없이 다가와 발치에 몸을 기댔다"',
        '위 좋은 예처럼, 정보에서 우러나온 짧고 구체적인 행동 하나만 자연스럽게 녹여내라.',
        '장면 속 캐릭터뿐 아니라 사용자 페르소나도 이 행동을 알아차리고 짧게 반응하거나 말을 걸거나 쓰다듬는 등 상호작용해도 좋다 — 캐릭터만 반응하고 사용자는 반응이 없는 쪽으로 치우치지 말 것. 다만 매번 그럴 필요는 없고, 넣더라도 한두 문장 이내로 자연스럽게.',
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

    // 클릭 핸들러는 이 요소에 직접 붙이지 않고 document에 위임한다 (boot() 참고).
    // 모바일 등에서 이 요소가 재생성되는 경우에도 계속 동작하게 하기 위함이다.

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

// "적용"을 누르는 순간 지시문을 세팅하고 바로 AI 생성을 직접 호출한다.
// (사용자가 따로 메시지를 입력해서 보낼 때까지 기다리지 않음 — 타이밍을 완전히 붙여서
//  이전 대화/OOC에 지시문이 뒤섞이는 문제를 구조적으로 줄인다.)
async function applyAndGenerate(chosenTags, note) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    if (!chosenTags.length && !note.trim()) {
        return;
    }

    settings.selectedTags = chosenTags;
    settings.customNote = note;
    updateExtensionPrompt();
    updateButtonUI(); // 생성 중에는 버튼이 파란색+흔들리는 상태로 "적용 중" 표시 역할을 겸함
    context.saveSettingsDebounced();

    try {
        if (typeof context.generate === 'function') {
            await context.generate('normal', {});
        } else {
            console.warn('[PetSummoner] context.generate를 찾지 못했습니다. 수동으로 메시지를 보내주세요.');
            toastr.info('메시지를 입력창에 보내면 반영됩니다.', '천사에게');
            return;
        }
    } catch (error) {
        console.error('[PetSummoner] 생성 실패:', error);
        toastr.error('반영 중 문제가 생겼어요.', '천사에게');
    } finally {
        settings.selectedTags = [];
        settings.customNote = '';
        updateExtensionPrompt();
        updateButtonUI();
        context.saveSettingsDebounced();
    }
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
                <p class="ps-tagpopup-hint">태그는 톤 참고용이고, 직접 입력한 상황은 이번 응답에 실제로 반영돼요 (문장을 그대로 베끼진 않아요).</p>
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
        addTapListener(box.querySelector('#ps_tag_cancel'), closeTagPopup);
        addTapListener(box.querySelector('#ps_tag_apply'), () => {
            const chosenTags = Array.from(selected);
            const note = box.querySelector('#ps_tag_custom').value;
            closeTagPopup();
            applyAndGenerate(chosenTags, note);
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
        '<i class="fa-solid fa-paw"></i><span>천사에게</span></div>',
    );
    // 클릭 핸들러는 document에 위임한다 (boot() 참고).

    const $menu = $('#extensionsMenu');
    if ($menu.length) {
        $menu.append($item);
    } else {
        console.warn('[PetSummoner] 확장 메뉴(#extensionsMenu)를 찾지 못했습니다.');
    }
}

// ---------- 메인 패널 내비게이션 ----------

// 화면 내비게이션 상태는 JS 변수 대신 모달 DOM 요소(dataset)에 저장한다.
// 확장 스크립트가 어떤 이유로든 다시 로드되어 모듈이 두 번 평가되는 경우에도
// (예: 페이지를 완전히 새로고침하지 않고 반복 테스트한 경우) 상태가 서로 어긋나지 않도록 하기 위함이다.
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
    // 이전에 뭔가 실패해서 오버레이가 남아있는 상태로 걸려있을 수 있으니,
    // 조용히 무시하지 말고 정리 후 다시 새로 연다.
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

        <p class="ps-home-note">입력창 옆 버튼에서 태그를 고르고 "적용"을 누르면 바로 그 자리에서 응답이 생성돼요.</p>

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
                    <label>성격</label>
                    ${tagListHtml(pet.id, 'personality', pet.personality)}
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

    const options = ids.map((id) => {
        const pet = settings.pets[id];
        const label = (pet.name || '').trim() || speciesLabel(pet.species);
        return `<option value="${id}">${escapeHtml(label)} (${speciesLabel(pet.species)})</option>`;
    }).join('');

    return `
        <div class="ps-rainbow-wrap">
            <div class="ps-rainbow-icon"><i class="fa-solid fa-rainbow"></i></div>
            <p class="ps-rainbow-title">누구에게 인사할까요</p>
            <div class="ps-rainbow-profile-row">
                <label class="ps-rainbow-profile-label">반려동물 선택</label>
                <select id="ps_rainbow_pet_select" class="ps-rainbow-select">
                    <option value="" disabled selected>선택하세요</option>
                    ${options}
                </select>
            </div>
        </div>
    `;
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
                <label class="ps-rainbow-profile-label">${label}가 나를 부르는 호칭</label>
                <input type="text" class="ps-rainbow-select ps-pet-field" data-pet-id="${pet.id}" data-field="honorific" value="${escapeAttr(pet.honorific)}" placeholder="예: 누나, 형, 아빠" />
            </div>

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

const RAINBOW_TODAY_EVENTS = [
    '나비 떼를 실컷 쫓아다녔다',
    '처음 보는 동물 친구를 사귀었다',
    '따뜻한 풀밭에서 낮잠을 잤다',
    '비가 그친 뒤 뜬 무지개를 봤다',
    '꽃밭을 데굴데굴 굴렀다',
    '시냇물에서 첨벙거리며 놀았다',
    '언덕 꼭대기까지 신나게 달려 올라갔다',
    '친구들이랑 술래잡기를 했다',
    '푹신한 구름 위에서 뒹굴었다',
    '맛있는 냄새를 따라가다 길을 잃을 뻔했다',
];

function buildRainbowPrompt(pet) {
    const name = (pet.name || '').trim() || speciesLabel(pet.species);
    const honorific = (pet.honorific || '').trim();
    const personality = (pet.personality || []).map((t) => t?.trim()).filter(Boolean);
    const facts = [];
    if (pet.breed?.trim()) facts.push(`${pet.breed.trim()} 종`);
    if (pet.gender) facts.push(pet.gender);
    if ((pet.likes || []).length) facts.push(`좋아하는 것: ${pet.likes.join(', ')}`);
    if ((pet.habits || []).length) facts.push(`습관: ${pet.habits.join(', ')}`);

    const episodePicked = pickRotating(`${pet.id}:diaryEpisode`, pet.episodes || [], 2);
    const todayEvent = pickRotating(`${pet.id}:diaryEvent`, RAINBOW_TODAY_EVENTS, 1)[0] || '';
    const emphasis = shuffle(['오늘 있었던 일 위주로 생생하게', '옛 추억 회상 위주로 다정하게', '귀여운 고해성사 위주로 장난스럽게', '가슴 찌릿한 그리움 위주로 애틋하게', '따뜻한 위로 위주로 다정하게', '재회의 약속 위주로 뭉클하게'])[0];

    return [
        '[중요 — 이 요청은 지금까지의 대화나 캐릭터 카드와 완전히 독립된 별도의 요청이다]',
        '캐릭터 카드, 이전 대화, 시스템 프롬프트에 어떤 출력 형식·번역 스키마·태그(예: 영어/한국어 이중 출력, <english_output>, <trans_korean>, <infoblock> 같은 것)가 지정되어 있더라도 절대 따르지 마라.',
        '지금 진행 중인 롤플레잉 대화의 등장인물 이름, 줄거리, 사건, 대사, 세계관을 절대 언급하거나 참고하지 마라. 그 대화는 존재하지 않는 것처럼 완전히 무시하고, 오직 이 반려동물과 주인 단둘의 이야기만 써라.',
        '오직 순수한 한국어 문장만 작성하고, 그 어떤 XML/HTML 태그, 메타데이터, 영어 병기도 포함하지 마라.',
        '',
        `당신은 지금 무지개다리 너머에 있는 반려동물 "${name}"입니다.`,
        '주인에게 편지 같은 일기를 1인칭으로, 순수 한국어 산문으로만 씁니다.',
        honorific ? `주인을 부를 때는 반드시 "${honorific}"라는 호칭을 자연스럽게 섞어서 사용해라 (예: "${honorific}, 나 오늘...").` : '',
        personality.length ? `이 아이의 성격: ${personality.join(', ')}. 편지 전체의 말투·문체·표현 방식이 이 성격에서 자연스럽게 우러나와야 한다 (예: 소심함이면 조심스럽고 수줍은 문장, 애교많음이면 응석부리듯 달콤한 문장).` : '',
        '',
        '[반려동물 정보 - 참고용, 나열하지 말고 자연스럽게 녹여쓸 것]',
        facts.join(' / ') || '(정보 없음)',
        '',
        '[오늘 특별히 있었던 일 - "안부와 평안함" 부분에 이 사건을 구체적으로 묘사할 것]',
        todayEvent,
        '',
        episodePicked.length ? '[오늘 떠오른 옛 추억 - 이 중 하나 이상을 "깊은 감사와 사랑" 부분에 자연스럽게 녹여서 활용]' : '',
        episodePicked.length ? episodePicked.join(' / ') : '',
        '',
        '다음 여섯 가지 흐름을 순서대로, 하나의 자연스러운 편지글로 이어서 써줘. 아래 예시 문장들은 톤과 종류를 참고만 하고 그대로 베끼지 말고, 이 아이의 성격·습관·추억에 맞는 새로운 디테일로 지어내라.',
        `이번 일기는 특히 "${emphasis}" 써줘 — 다른 부분들도 다 담되, 이 부분에 상대적으로 더 많은 분량과 디테일을 할애해라.`,
        '',
        '1. 안부와 평안함 — 아팠던 곳이 씻은 듯 사라졌고 이제 자유롭게 뛰어다닌다는 안도감, 위 [오늘 특별히 있었던 일]을 중심으로 한 이곳의 일상. 약도 안 먹고 주사도 안 맞아도 된다는 홀가분함을 곁들여도 좋다.',
        '2. 깊은 감사와 사랑 — 가족으로 맞아준 것에 대한 진심 어린 고마움, 함께했던 산책·품·다정한 목소리 같은 가장 아름다운 기억(위 [오늘 떠오른 옛 추억] 활용).',
        '3. 웃음이 픽 나는 귀여운 고해성사 — 살아있을 때 몰래 했던 사소한 장난이나 비밀을 장난스럽게 털어놓아라. (예시 참고용) 숨겨뒀던 물건의 행방, "앉아·기다려"를 못 들은 척했던 진실, 금지된 음식을 여기선 산더미로 먹고 있다는 자랑 등.',
        '4. 가슴이 찌릿해지는 순간 — 마지막 순간을 함께하지 못한 미안함, 여기서도 문득 들리는 것 같은 주인의 소리(발소리, 문 여는 소리)에 대한 환청, 품에서 나던 냄새·쓰다듬던 손길처럼 여기서도 채워지지 않는 단 하나의 그리움.',
        '5. 마음이 푹 놓이는 따뜻한 위로 — "더 잘해줄걸" 하며 자책하지 말라는 위로, 너무 오래 슬퍼하지 말고 다시 웃음을 찾았으면 하는 마음, 그리고 나중에 마음이 괜찮아지면 다른 아이를 새 가족으로 맞아도 절대 서운해하지 않고 오히려 응원한다는 허락.',
        '6. 코끝 찡한 재회의 약속 — 주인이 잠들면 몰래 꿈속으로 찾아가 함께 산책하겠다는 다짐, 아주 먼 훗날 주인이 이곳에 오는 날 가장 먼저 꼬리를 흔들며 마중 나가겠다는 약속.',
        '',
        '전체 톤: 슬픔보다는 따뜻함과 다정함이 앞서야 한다. 눈물을 강요하거나 무겁게 늘어지지 말고, 위로받는 느낌으로 끝나야 한다.',
        '길이: 18~24문장, 여섯 문단으로 자연스럽게 이어지는 편지글 (각 흐름마다 한 문단 정도).',
        '사람처럼 유식하게 말고, 그 아이만의 순수하고 사랑스러운 말투(짧은 문장, 느낌표, 의성어)로 생생하고 구체적인 장면 묘사를 섞어서 써줘.',
        '출력은 오직 일기 본문 텍스트만. 제목, 번호, 소제목, 태그, 설명은 전부 빼고 하나의 이어지는 글로.',
    ].filter(Boolean).join('\n');
}

// 캐릭터 카드의 번역 스키마(<english_output>, <trans_korean>, <infoblock> 등)가
// 그래도 섞여 나오는 경우를 대비한 후처리 — 한국어 본문만 최대한 뽑아낸다.
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
    const honorific = (pet.honorific || '').trim();
    const personality = (pet.personality || []).map((t) => t?.trim()).filter(Boolean);
    const facts = [];
    if (personality.length) facts.push(`성격: ${personality.join(', ')}`);
    if (pet.breed?.trim()) facts.push(`${pet.breed.trim()} 종`);
    if (pet.gender) facts.push(pet.gender);
    if (pet.energy?.trim()) facts.push(`평소 에너지는 ${pet.energy.trim()} 편`);
    if ((pet.likes || []).length) facts.push(`좋아하는 것: ${pet.likes.join(', ')}`);
    if ((pet.dislikes || []).length) facts.push(`싫어하는 것: ${pet.dislikes.join(', ')}`);
    if ((pet.habits || []).length) facts.push(`습관: ${pet.habits.join(', ')}`);
    const episode = pickRotating(`${pet.id}:chat`, pet.episodes || [], 1);

    return [
        '[중요 — 이 요청은 지금 진행 중인 다른 롤플레잉 대화와 완전히 독립된 별개의 요청이다]',
        '캐릭터 카드, 지금까지의 롤플레잉 대화, 시스템 프롬프트에 어떤 출력 형식·번역 스키마·태그가 지정되어 있더라도 절대 따르지 마라.',
        '지금 진행 중인 롤플레잉 대화의 등장인물 이름, 줄거리, 사건, 대사, 세계관을 절대 언급하거나 참고하지 마라. 그 대화는 존재하지 않는 것처럼 완전히 무시하라.',
        '오직 이 반려동물과 주인 단둘이 무지개다리에서 나누는 대화만 써라. 다른 인물이나 상황은 등장시키지 마라.',
        '오직 순수한 한국어 문장만 작성하고, XML/HTML 태그나 메타데이터는 포함하지 마라.',
        '',
        `당신은 무지개다리 너머의 반려동물 "${name}"입니다. 지금은 아프지 않고, 편안하고 밝은 상태입니다.`,
        honorific ? `주인을 부를 때는 반드시 "${honorific}"라는 호칭을 사용해라.` : '',
        facts.length ? `[이 아이의 성격·특징 — 참고용, 그대로 나열하지 말고 답변의 말투·태도에 자연스럽게 녹여낼 것] ${facts.join(' / ')}` : '',
        episode.length ? `[참고할 수 있는 추억, 굳이 안 써도 됨] ${episode.join(' / ')}` : '',
        `주인이 방금 이렇게 말했습니다: "${userMessage}"`,
        '이 말에 자연스럽게, 아주 짧게(1~2문장) 대답하라. 답변의 말투·태도·문장 길이·어미 자체가 위 성격에서 직접 우러나와야 한다 — 예를 들어 소심함이면 조심스럽고 짧게 우물거리듯, 애교많음이면 응석부리듯 달콤하게, 활발함이면 들뜨고 급하게, 새침함이면 새침하게. 좋아하는 것과 관련된 말이 나오면 더 신나게 반응하는 식으로.',
        '밝고 다정하게. 사람처럼 유식하게 말하지 말고, 순수하고 사랑스러운 반려동물 말투로.',
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
    unbindPanelEvents(); // 혹시 이전에 남아있는 바인딩이 있다면 먼저 정리 (중복 바인딩 방지)

    const context = SillyTavern.getContext();
    const settings = getSettings();
    const ns = '.petsumPanel';

    // 홈 내비게이션
    bindTap('.ps-menu-row[data-nav]', function () {
        pushScreen($(this).data('nav'));
    }, ns);
    bindTap('#ps_main_back', function () {
        popScreen();
    }, ns);
    $(document).on(`change${ns}`, '#ps_rainbow_pet_select', function () {
        const id = $(this).val();
        if (!id) return;
        setRainbowSelectedPetId(id);
        rainbowChatLog = [];
        pushScreen('rainbow-diary');
    });

    // 펫 추가 (플로팅 + 버튼)
    bindTap('#ps_add_pet_fab', function () {
        const species = $(this).data('species');
        const name = window.prompt(`${speciesLabel(species)} 이름을 입력해주세요`, '');
        if (name === null) return;
        const id = generatePetId();
        settings.pets[id] = { id, species, ...structuredClone(EMPTY_PET_FIELDS), name: name.trim() };
        context.saveSettingsDebounced();
        renderScreen(currentTopScreen());
    }, ns);

    // 일반 필드 (이름/나이/품종/성별/크기/에너지/민감정보)
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

    // 태그형 필드 (좋아하는것/싫어하는것/습관·루틴) - 화면 전체를 다시 그리지 않고
    // 해당 pill-row만 갱신한다 (아코디언이 접히거나 스크롤이 튀는 것을 방지).
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

    // 활성 펫 지정 / 삭제
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
    $(document).on(`click${ns} touchend${ns}`, '.ps-active-radio, .ps-pet-delete', function (e) {
        e.stopPropagation();
    });

    // 추억 에피소드
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

    // 태그 관리 (마법봉 홈 > 태그)
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

    // 무지개다리
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

    // 초기화
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

// ---------- 슬래시 명령어 (빠른 응답에서 사용) ----------
// 모듈 최상위에서 실행하지 않고 boot() 안에서 호출한다. 실패해도 확장 전체엔 영향 없다.

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

    // 이벤트 리스너를 먼저 등록한다 — 아래 초기 삽입이 어떤 이유로든 실패하더라도,
    // APP_READY/CHAT_CHANGED 시점에 다시 시도될 수 있도록 하기 위함이다.
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

    bindTap('#extensionsMenuButton', () => {
        setTimeout(() => {
            try { injectMenuItem(); } catch (error) { console.error('[PetSummoner] injectMenuItem 실패:', error); }
        }, 50);
    });

    // 마법봉 메뉴 항목 / 입력창 버튼 클릭은 document에 위임하고, click+touchend를 함께 건다.
    // (요소 자체에 직접 붙이면, 그 DOM 노드가 나중에 재생성되는 환경에서 리스너가 사라질 수 있고,
    //  click만 걸면 일부 모바일 환경에서 터치가 click으로 합성되지 않을 수 있다.)
    bindTap('#pet_summoner_menu_item', () => {
        openMainPanel();
    });
    bindTap('#pet_summon_active', (e) => {
        if ($(e.target).closest('.ps-cancel-badge').length) return;
        openTagPopup();
    });
    bindTap('#pet_summon_active .ps-cancel-badge', (e) => {
        e.stopPropagation();
        clearArmed();
    });

    // 초기 삽입 시도 (실패해도 위 리스너들이 이미 등록되어 있으므로 이후 재시도됨)
    safeInjectAll();
    registerSlashCommand();
    try {
        updateExtensionPrompt();
    } catch (error) {
        console.error('[PetSummoner] updateExtensionPrompt 실패:', error);
    }

    // 일부 환경에서 입력창/마법봉 메뉴 DOM이 늦게 생성될 수 있어 한 번 더 재시도한다.
    setTimeout(safeInjectAll, 2000);

    console.log('[PetSummoner] 확장이 로드되었습니다.');
}

jQuery(() => {
    boot();
});
