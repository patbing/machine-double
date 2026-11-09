/* Machine Double configuration. Classic script. */
(function () {
  'use strict';
  window.MD = window.MD || {};
  window.MD.config = {
    // Public App Key (pk_...) from enter.pollinations.ai/keys -> Apps. Safe to commit.
    APP_KEY: 'pk_IGVeYnBmDkULmg1Z',
    REPO_URL: 'https://github.com/patbing/machine-double',
    API: 'https://gen.pollinations.ai',
    MAX_DOUBLES: 3,
    // Cheap, healthy, non-paid-only text models picked first when someone connects.
    DEFAULT_MODELS: ['openai/gpt-5.4-nano', 'deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'],
    MAX_TOKENS: 3000,
    TIMEOUT_MS: 45000
  };
})();
