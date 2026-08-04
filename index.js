// 펫 소환기 (Pet Summoner) v3 - SillyTavern extension
//
// extension_prompt_types / extension_prompt_roles 는 getContext()에 항상 노출되지 않을 수 있어
// script.js에서 직접 가져옵니다 (공식 문서에서도 허용하는 패턴입니다).
import { extension_prompt_types, extension_prompt_roles } from '../../../../script.js';

const MODULE_NAME = 'pet_summoner';
const PROMPT_KEY = 'pet_summoner_prompt';

// renderExtensionTemplateAsync에 넘기는 폴더 이름은 실제 설치 폴더 이름과 같아야 합니다.
// 폴더 이름을 바꿔서 설치했다면 아래 값도 함께 바꿔주세요.
const EXTENSION_FOLDER = 'third-party/pet-summoner';

const EMPTY_PET = Object.freeze({
    name: '', age: '', breed: '', size: '',
    likes: '', dislikes: '', habits: '', sound: '', energy: '',
    health: '', routine: '', episodes: [],
});

const defaultSettings = Object.freeze({
    activePet: null, // 'dog' | 'cat' | null
    selectedTags: [],
    oneShot: true,
    pets: {
        dog: structuredClone(EMPTY_PET),
        cat: structuredClone(EMPTY_PET),
    },
    tags: {
        interaction: ['애교부리기', '앙탈부리기', '장난치기', '그냥 등장하기', '혼자 할일하기', '반갑게 맞이하기', '곁에 있어주기', '관심 끌기', '질투하기', '놀라기', '신나기'],
        routine: ['산책하기', '밥 먹기', '약 먹이기 · 병원가기', '목욕 · 그루밍', '낮잠 · 잠자기', '장난감 놀이', '훈련 · 손'],
    },
});

function speciesLabel(key) {
    return key === 'dog' ? '강아지' : '고양이';
}

function escapeHtml(str) {
    return $('<div>').text(str == null ? '' : String(str)).html();
}

function getSettings() {
    const context = SillyTavern.getContext();

    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = context.extensionSettings[MODULE_NAME];

    if (!settings.pets) settings.pets = {};
    for (const key of ['dog', 'cat']) {
        if (!settings.pets[key]) settings.pets[key] = structuredClone(EMPTY_PET);
        for (const field of Object.keys(EMPTY_PET)) {
            if (settings.pets[key][field] === undefined) {
                settings.pets[key][field] = structuredClone(EMPTY_PET[field]);
            }
        }
    }
    if (!settings.tags) settings.tags = structuredClone(defaultSettings.tags);
    if (!Array.isArray(settings.tags.interaction)) settings.tags.interaction = structuredClone(defaultSettings.tags.interaction);
    if (!Array.isArray(settings.tags.routine)) settings.tags.routine = structuredClone(defaultSettings.tags.routine);
    if (!Array.isArray(settings.selectedTags)) settings.selectedTags = [];
    if (settings.oneShot === undefined) settings.oneShot = true;
    if (settings.activePet === undefined) settings.activePet = null;

    return settings;
}

// ---------- 프롬프트 빌드 ----------
//
// 설계 원칙:
// - 프로필 정보를 "라벨: 값" 목록으로 나열하지 않는다 (그대로 베끼기 쉬워짐).
// - 매번 배경 사실 + 에피소드를 합친 풀에서 1~2개만 무작위로 골라 라벨 없이 흘려준다.
// - "하지 말 것"을 구체적으로 명시하고, 나쁜 예/좋은 예를 직접 보여준다.

function collectBackgroundFacts(pet) {
    const facts = [];
    if (pet.age?.trim()) facts.push(`나이는 ${pet.age.trim()} 정도`);
    if (pet.breed?.trim()) facts.push(`${pet.breed.trim()} 종`);
    if (pet.size?.trim()) facts.push(`${pet.size.trim()} 체구`);
    if (pet.likes?.trim()) facts.push(`${pet.likes.trim()}을(를) 좋아함`);
    if (pet.dislikes?.trim()) facts.push(`${pet.dislikes.trim()}을(를) 싫어함`);
    if (pet.habits?.trim()) facts.push(pet.habits.trim());
    if (pet.sound?.trim()) facts.push(`소리를 낼 때는 ${pet.sound.trim()}`);
    if (pet.energy?.trim()) facts.push(`평소 에너지는 ${pet.energy.trim()} 편`);
    if (pet.health?.trim()) facts.push(pet.health.trim());
    if (pet.routine?.trim()) facts.push(pet.routine.trim());
    return facts;
}

function pickRandom(list, n) {
    const pool = (list || []).map((x) => (x || '').trim()).filter(Boolean);
    if (pool.length === 0) return [];
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(n, shuffled.length));
}

function buildInstructionText() {
    const settings = getSettings();
    if (!settings.activePet) return '';
    if (!settings.selectedTags || settings.selectedTags.length === 0) return '';

    const pet = settings.pets[settings.activePet];
    const name = (pet.name || '').trim() || speciesLabel(settings.activePet);
    const facts = collectBackgroundFacts(pet);
    const episodes = pet.episodes || [];
    const pool = [...facts, ...episodes];
    const picked = pickRandom(pool, 2);

    const lines = [
        '[반려동물 등장 지시 — 시스템]',
        `다음 응답에 "${name}"(${speciesLabel(settings.activePet)})이 자연스럽게 함께 있는 것으로 서술하라.`,
        `지금 반응 톤(참고용 키워드, 그대로 쓰지 말 것): ${settings.selectedTags.join(', ')}`,
    ];

    if (picked.length) {
        lines.push(`참고 배경(이 중 떠오르는 인상만 은근히 반영, 절대 그대로 옮기지 말 것): ${picked.join(' / ')}`);
    }

    lines.push(
        '금지 사항:',
        '- 나이·품종·병명 등 사실 단어를 문장에 직접 쓰지 말 것.',
        '- "질투하며", "애교부리듯"처럼 위 반응 톤 단어를 그대로 감정 서술어로 쓰지 말 것.',
        '- 배경 정보를 나열하거나 요약해서 설명하지 말 것.',
        '나쁜 예 (금지): "신부전을 앓는 15살 슈나우저 믹스가 질투하며 다가왔다"',
        '좋은 예 (허용): "작은 발소리가 들리더니, 말없이 다가와 발치에 몸을 기댔다"',
        '위 좋은 예처럼, 정보에서 우러나온 짧고 구체적인 행동 하나만 자연스럽게 녹여내라.',
    );

    return lines.join('\n');
}

function updateExtensionPrompt() {
    const context = SillyTavern.getContext();
    const text = buildInstructionText();

    context.setExtensionPrompt(
        PROMPT_KEY,
        text,
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

// ---------- 입력창 옆 단일 버튼 ----------

function updateButtonUI() {
    const settings = getSettings();
    const $btn = $('#pet_summon_active');
    if (!$btn.length) return;

    $btn.empty();
    if (settings.activePet === 'dog') {
        $btn.append('<i class="fa-solid fa-dog"></i>');
        $btn.attr('title', `${(settings.pets.dog.name || '').trim() || '강아지'} · 클릭해서 반응 방식 선택`);
    } else if (settings.activePet === 'cat') {
        $btn.append('<i class="fa-solid fa-cat"></i>');
        $btn.attr('title', `${(settings.pets.cat.name || '').trim() || '고양이'} · 클릭해서 반응 방식 선택`);
    } else {
        $btn.append('<i class="fa-solid fa-paw"></i>');
        $btn.attr('title', '마법봉 메뉴의 "펫 소환기"에서 반려동물을 먼저 선택하세요');
    }

    $btn.toggleClass('armed', !!(settings.selectedTags && settings.selectedTags.length));
}

function injectButtons() {
    if ($('#pet_summon_active').length) return;

    const $btn = $('<div id="pet_summon_active" class="pet-summon-btn interactable" tabindex="0"></div>');
    $btn.on('click', () => openTagPopup());

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

async function openTagPopup() {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    const settings = getSettings();

    if (!settings.activePet) {
        toastr.warning('마법봉 메뉴의 "펫 소환기"에서 반려동물을 먼저 선택해주세요.', '펫 소환기');
        return;
    }

    const pet = settings.pets[settings.activePet];
    const name = (pet.name || '').trim() || speciesLabel(settings.activePet);
    const icon = settings.activePet === 'dog' ? 'fa-dog' : 'fa-cat';

    const selected = new Set(settings.selectedTags || []);

    function renderGroup(list) {
        return list.map((tag) => {
            const cls = selected.has(tag) ? 'petsum-pill active' : 'petsum-pill';
            return `<span class="${cls}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`;
        }).join('');
    }

    const html = `
        <div class="pet-summoner-tagpopup">
            <div class="ps-tagpopup-header"><i class="fa-solid ${icon}"></i>${escapeHtml(name)}이(가) 지금 어떻게 반응할까요</div>
            <p class="ps-tagpopup-label">상호작용 방식</p>
            <div class="ps-pill-row">${renderGroup(settings.tags.interaction)}</div>
            <p class="ps-tagpopup-label">함께하는 루틴</p>
            <div class="ps-pill-row">${renderGroup(settings.tags.routine)}</div>
            <p class="ps-tagpopup-hint">여러 개 선택할 수 있어요. 다음 응답 1회에 반영됩니다.</p>
        </div>
    `;

    const clickHandler = function () {
        const tag = $(this).data('tag');
        $(this).toggleClass('active');
        if (selected.has(tag)) selected.delete(tag); else selected.add(tag);
    };
    $(document).on('click.petsumTag', '.petsum-pill', clickHandler);

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { okButton: '적용', cancelButton: '취소' });
    const result = await popup.show();

    $(document).off('click.petsumTag', '.petsum-pill', clickHandler);

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        settings.selectedTags = Array.from(selected);
        updateExtensionPrompt();
        updateButtonUI();
        context.saveSettingsDebounced();
        if (settings.selectedTags.length) {
            toastr.info('다음 응답에 반영됩니다.', '펫 소환기');
        }
    }
}

// ---------- 마법봉 메뉴 항목 + 메인 관리 패널 ----------

function injectMenuItem() {
    if ($('#pet_summoner_menu_item').length) return;

    const $item = $(
        '<div id="pet_summoner_menu_item" class="list-group-item flex-container flexGap5 interactable" tabindex="0">' +
        '<i class="fa-solid fa-paw"></i><span>펫 소환기</span></div>',
    );
    $item.on('click', openMainPanel);

    const $menu = $('#extensionsMenu');
    if ($menu.length) {
        $menu.append($item);
    } else {
        console.warn('[PetSummoner] 확장 메뉴(#extensionsMenu)를 찾지 못했습니다.');
    }
}

async function openMainPanel() {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE } = context;

    const html = await context.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'panel', {});
    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, okButton: '닫기', allowVerticalScrolling: true });

    bindPanelEvents();
    requestAnimationFrame(() => {
        renderAllDynamicLists();
        loadStaticFieldValues();
    });

    await popup.show();
    unbindPanelEvents();
}

function loadStaticFieldValues() {
    const settings = getSettings();
    for (const key of ['dog', 'cat']) {
        const pet = settings.pets[key];
        $(`#ps_${key}_name`).val(pet.name);
        $(`#ps_${key}_age`).val(pet.age);
        $(`#ps_${key}_breed`).val(pet.breed);
        $(`#ps_${key}_size`).val(pet.size);
        $(`#ps_${key}_likes`).val(pet.likes);
        $(`#ps_${key}_dislikes`).val(pet.dislikes);
        $(`#ps_${key}_habits`).val(pet.habits);
        $(`#ps_${key}_sound`).val(pet.sound);
        $(`#ps_${key}_energy`).val(pet.energy || '');
        $(`#ps_${key}_health`).val(pet.health);
        $(`#ps_${key}_routine`).val(pet.routine);
    }
    $('#ps_active_dog').prop('checked', settings.activePet === 'dog');
    $('#ps_active_cat').prop('checked', settings.activePet === 'cat');
    $('#ps_oneshot').prop('checked', !!settings.oneShot);
}

function renderEpisodes(key) {
    const settings = getSettings();
    const $list = $(`#ps_${key}_episodes_list`);
    if (!$list.length) return;
    $list.empty();

    (settings.pets[key].episodes || []).forEach((text, idx) => {
        const $row = $(
            `<div class="ps-episode-row" data-index="${idx}" data-pet="${key}">
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
            `<span class="petsum-pill petsum-pill-mgr" data-group="${group}" data-tag="${escapeHtml(tag)}">
                ${escapeHtml(tag)} <i class="fa-solid fa-xmark ps-tag-remove"></i>
            </span>`,
        );
        $list.append($pill);
    });
}

function renderAllDynamicLists() {
    renderEpisodes('dog');
    renderEpisodes('cat');
    renderTagManager('interaction');
    renderTagManager('routine');
}

function bindPanelEvents() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const ns = '.petsumPanel';

    for (const key of ['dog', 'cat']) {
        for (const field of ['name', 'age', 'breed', 'size', 'likes', 'dislikes', 'habits', 'sound', 'health', 'routine']) {
            $(document).on(`input${ns}`, `#ps_${key}_${field}`, function () {
                settings.pets[key][field] = $(this).val();
                context.saveSettingsDebounced();
            });
        }
        $(document).on(`change${ns}`, `#ps_${key}_energy`, function () {
            settings.pets[key].energy = $(this).val();
            context.saveSettingsDebounced();
        });

        $(document).on(`click${ns}`, `#ps_${key}_episode_add`, function () {
            settings.pets[key].episodes = settings.pets[key].episodes || [];
            settings.pets[key].episodes.push('');
            renderEpisodes(key);
            context.saveSettingsDebounced();
        });
    }

    $(document).on(`change${ns}`, '#ps_active_dog', function () {
        settings.activePet = 'dog';
        updateButtonUI();
        context.saveSettingsDebounced();
    });
    $(document).on(`change${ns}`, '#ps_active_cat', function () {
        settings.activePet = 'cat';
        updateButtonUI();
        context.saveSettingsDebounced();
    });
    $(document).on(`click${ns}`, '.ps-active-radio', function (e) {
        e.stopPropagation();
    });

    $(document).on(`change${ns}`, '#ps_oneshot', function () {
        settings.oneShot = $(this).is(':checked');
        context.saveSettingsDebounced();
    });

    $(document).on(`input${ns}`, '.ps-episode-text', function () {
        const $row = $(this).closest('.ps-episode-row');
        const key = $row.data('pet');
        const idx = $row.data('index');
        settings.pets[key].episodes[idx] = $(this).val();
        context.saveSettingsDebounced();
    });

    $(document).on(`click${ns}`, '.ps-episode-remove', function () {
        const $row = $(this).closest('.ps-episode-row');
        const key = $row.data('pet');
        const idx = $row.data('index');
        settings.pets[key].episodes.splice(idx, 1);
        renderEpisodes(key);
        context.saveSettingsDebounced();
    });

    for (const group of ['interaction', 'routine']) {
        $(document).on(`click${ns}`, `#ps_tagadd_${group}_btn`, function () {
            const $input = $(`#ps_tagadd_${group}_input`);
            const val = ($input.val() || '').trim();
            if (!val) return;
            if (!settings.tags[group].includes(val)) {
                settings.tags[group].push(val);
                renderTagManager(group);
                context.saveSettingsDebounced();
            }
            $input.val('');
        });
    }

    $(document).on(`click${ns}`, '.ps-tag-remove', function (e) {
        e.stopPropagation();
        const $pill = $(this).closest('.petsum-pill-mgr');
        const group = $pill.data('group');
        const tag = $pill.data('tag');
        settings.tags[group] = settings.tags[group].filter((t) => t !== tag);
        renderTagManager(group);
        context.saveSettingsDebounced();
    });
}

function unbindPanelEvents() {
    $(document).off('.petsumPanel');
}

// ---------- 1회성 태그 초기화 ----------

function resetOneShotIfNeeded() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.oneShot) return;
    if (!settings.selectedTags || settings.selectedTags.length === 0) return;

    settings.selectedTags = [];
    updateExtensionPrompt();
    updateButtonUI();
    context.saveSettingsDebounced();
}

// ---------- 초기화 ----------

jQuery(async () => {
    const context = SillyTavern.getContext();

    injectButtons();
    injectMenuItem();

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        injectButtons();
        injectMenuItem();
    });

    context.eventSource.on(context.event_types.GENERATION_ENDED, resetOneShotIfNeeded);
    context.eventSource.on(context.event_types.GENERATION_STOPPED, resetOneShotIfNeeded);

    console.log('[PetSummoner] 확장이 로드되었습니다.');
});
