// 펫 소환기 (Pet Summoner) - SillyTavern extension
//
// extension_prompt_types / extension_prompt_roles 는 getContext()에 노출되지 않는 경우가 있어
// 안정성을 위해 script.js에서 직접 가져옵니다 (공식 문서에서도 허용하는 패턴입니다).
import { extension_prompt_types, extension_prompt_roles } from '../../../../script.js';

const MODULE_NAME = 'pet_summoner';
const PROMPT_KEY = 'pet_summoner_prompt';

// ⚠️ renderExtensionTemplateAsync에 넘기는 폴더 이름과 실제 설치 폴더 이름이 같아야 합니다.
// 폴더 이름을 바꿔서 설치했다면 아래 EXTENSION_FOLDER 값도 함께 바꿔주세요.
const EXTENSION_FOLDER = 'third-party/pet-summoner';

const defaultSettings = Object.freeze({
    pets: {
        dog: { name: '뽀삐', species: 'dog', traits: '', appearance: '', active: false },
        cat: { name: '나비', species: 'cat', traits: '', appearance: '', active: false },
    },
    oneShot: true,
});

function speciesLabel(key) {
    return key === 'dog' ? '강아지' : '고양이';
}

function getSettings() {
    const context = SillyTavern.getContext();

    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = context.extensionSettings[MODULE_NAME];

    // 업데이트 이후에도 누락된 필드가 없도록 보정
    if (!settings.pets) settings.pets = {};
    for (const key of Object.keys(defaultSettings.pets)) {
        if (!settings.pets[key]) {
            settings.pets[key] = structuredClone(defaultSettings.pets[key]);
        }
        for (const field of Object.keys(defaultSettings.pets[key])) {
            if (settings.pets[key][field] === undefined) {
                settings.pets[key][field] = defaultSettings.pets[key][field];
            }
        }
    }
    if (settings.oneShot === undefined) {
        settings.oneShot = true;
    }

    return settings;
}

function buildInstructionText(settings) {
    const activeKeys = Object.keys(settings.pets).filter((k) => settings.pets[k].active);
    if (activeKeys.length === 0) {
        return '';
    }

    const lines = activeKeys.map((k) => {
        const pet = settings.pets[k];
        const name = (pet.name || '').trim() || speciesLabel(k);
        const traits = (pet.traits || '').trim() || '(설정된 성격 정보 없음)';
        const appearance = (pet.appearance || '').trim() || '(설정된 외형 정보 없음)';
        return `- 이름: ${name} (${speciesLabel(k)})\n  성격/특징: ${traits}\n  외형: ${appearance}`;
    });

    return [
        '[반려동물 등장 지시 — 시스템]',
        '아래 반려동물이 지금 이 장면에 함께 있다. 다음 응답의 서술 속에 반려동물의 행동, 몸짓, 소리, 반응을',
        '짧고 자연스럽게 녹여 넣어라. 반려동물이 이야기의 중심이 되거나 사람처럼 말하게 하지 말고,',
        '실제 동물의 습성과 아래 설정에 맞게만 행동하게 하라.',
        lines.join('\n'),
    ].join('\n');
}

function updateExtensionPrompt() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const text = buildInstructionText(settings);

    context.setExtensionPrompt(
        PROMPT_KEY,
        text,
        extension_prompt_types.IN_CHAT,
        0, // depth 0 = 마지막 메시지 바로 다음 (가장 최근 컨텍스트)
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function updateButtonUI() {
    const settings = getSettings();
    for (const key of Object.keys(settings.pets)) {
        $(`#pet_summon_${key}`).toggleClass('active', !!settings.pets[key].active);
    }
}

function togglePet(key) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    settings.pets[key].active = !settings.pets[key].active;
    updateButtonUI();
    updateExtensionPrompt();
    context.saveSettingsDebounced();

    const label = (settings.pets[key].name || '').trim() || speciesLabel(key);
    if (settings.pets[key].active) {
        toastr.info(`${label}(을)를 다음 응답에 등장시킵니다.`, '펫 소환기');
    }
}

function resetOneShotIfNeeded() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.oneShot) return;

    let changed = false;
    for (const key of Object.keys(settings.pets)) {
        if (settings.pets[key].active) {
            settings.pets[key].active = false;
            changed = true;
        }
    }

    if (changed) {
        updateButtonUI();
        updateExtensionPrompt();
        context.saveSettingsDebounced();
    }
}

function injectButtons() {
    if ($('#pet_summoner_buttons').length) return;

    const $wrap = $('<div id="pet_summoner_buttons" class="pet-summoner-buttons"></div>');
    const $dog = $(
        '<div id="pet_summon_dog" class="pet-summon-btn interactable" tabindex="0" title="강아지 소환 (다음 응답)"><i class="fa-solid fa-dog"></i></div>',
    );
    const $cat = $(
        '<div id="pet_summon_cat" class="pet-summon-btn interactable" tabindex="0" title="고양이 소환 (다음 응답)"><i class="fa-solid fa-cat"></i></div>',
    );

    $dog.on('click', () => togglePet('dog'));
    $cat.on('click', () => togglePet('cat'));

    $wrap.append($dog).append($cat);

    // 입력창 옆(전송 버튼 영역)에 삽입합니다. ST 버전에 따라 DOM 구조가 다를 수 있어
    // 여러 위치를 순서대로 시도합니다.
    if ($('#rightSendForm').length) {
        $('#rightSendForm').prepend($wrap);
    } else if ($('#send_form').length) {
        $('#send_form').prepend($wrap);
    } else {
        console.warn('[PetSummoner] 입력창 영역을 찾지 못해 버튼을 추가하지 못했습니다.');
        return;
    }

    updateButtonUI();
}

async function injectSettingsUI() {
    const context = SillyTavern.getContext();
    const html = await context.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings', {});
    $('#extensions_settings2').append(html);

    const settings = getSettings();

    for (const key of Object.keys(settings.pets)) {
        $(`#petsum_${key}_name`)
            .val(settings.pets[key].name)
            .on('input', function () {
                settings.pets[key].name = $(this).val();
                if (settings.pets[key].active) updateExtensionPrompt();
                context.saveSettingsDebounced();
            });

        $(`#petsum_${key}_traits`)
            .val(settings.pets[key].traits)
            .on('input', function () {
                settings.pets[key].traits = $(this).val();
                if (settings.pets[key].active) updateExtensionPrompt();
                context.saveSettingsDebounced();
            });

        $(`#petsum_${key}_appearance`)
            .val(settings.pets[key].appearance)
            .on('input', function () {
                settings.pets[key].appearance = $(this).val();
                if (settings.pets[key].active) updateExtensionPrompt();
                context.saveSettingsDebounced();
            });
    }

    $('#petsum_oneshot')
        .prop('checked', !!settings.oneShot)
        .on('change', function () {
            settings.oneShot = $(this).is(':checked');
            context.saveSettingsDebounced();
        });
}

jQuery(async () => {
    const context = SillyTavern.getContext();

    try {
        await injectSettingsUI();
    } catch (error) {
        console.error('[PetSummoner] 설정 패널 로딩 실패:', error);
    }

    injectButtons();

    // 채팅을 전환해도 버튼이 사라지지 않도록 다시 삽입 시도
    context.eventSource.on(context.event_types.CHAT_CHANGED, injectButtons);

    // 응답 생성이 끝나면(성공/에러 모두) 1회성 토글을 자동으로 해제
    context.eventSource.on(context.event_types.GENERATION_ENDED, resetOneShotIfNeeded);
    context.eventSource.on(context.event_types.GENERATION_STOPPED, resetOneShotIfNeeded);

    console.log('[PetSummoner] 확장이 로드되었습니다.');
});
