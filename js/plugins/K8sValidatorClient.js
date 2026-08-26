/*:
 * @plugindesc HTTP client for the independent Kubernetes validator sidecar.
 * @author etg227
 *
 * @help
 * Talks to validator/server.js, which inspects the real cluster with kubectl
 * and returns the validation-result contract consumed by K8sQuestEngine.
 *
 * URL parameters:
 *   validatorUrl=<url>   Override the validator base URL.
 *   validator=0          Disable cluster validation entirely.
 *
 * Defaults:
 *   - When the game is served over http(s) (e.g. by the sidecar itself),
 *     the validator is assumed to live on the same origin.
 *   - When the game is opened from disk (file://), the default is
 *     http://localhost:8787.
 *
 * The client is inactive in legacy mode (baseUrl/apiKey/game parameters),
 * where validation flows through the original grader backend instead.
 */

(function () {
  'use strict';

  var RETRY_AFTER_MS = 10000;
  var urlParams = new URLSearchParams(window.location.search);
  var legacyMode = Boolean(
    urlParams.get('baseUrl') &&
      urlParams.get('apiKey') &&
      urlParams.get('game'),
  );
  var disabled = urlParams.get('validator') === '0' || legacyMode;
  var explicitUrl = urlParams.get('validatorUrl');
  var baseUrl;
  if (explicitUrl !== null) {
    baseUrl = explicitUrl.replace(/\/+$/, '');
  } else if (window.location.protocol.indexOf('http') === 0) {
    baseUrl = '';
  } else {
    baseUrl = 'http://localhost:8787';
  }

  var unavailableUntil = 0;

  function isEnabled() {
    return !disabled && Date.now() >= unavailableUntil;
  }

  function addMessage(text) {
    if (text && $gameMessage) $gameMessage.add(text);
  }

  function checkQuest(questId, onUnavailable) {
    if (!isEnabled()) {
      if (typeof onUnavailable === 'function') onUnavailable();
      return;
    }

    var url = baseUrl + '/api/validate?questId=' + encodeURIComponent(questId);
    fetch(url)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (result) {
        if (window.K8sQuestEngine) {
          window.K8sQuestEngine.applyValidationResult(result);
        }
      })
      .catch(function (error) {
        console.warn('K8sValidatorClient: validator unreachable', error);
        unavailableUntil = Date.now() + RETRY_AFTER_MS;
        addMessage('I cannot reach the Kubernetes validator right now.');
        if (typeof onUnavailable === 'function') onUnavailable();
      });
  }

  window.K8sValidatorClient = {
    baseUrl: function () {
      return baseUrl;
    },
    checkQuest: checkQuest,
    isEnabled: isEnabled,
  };
})();
