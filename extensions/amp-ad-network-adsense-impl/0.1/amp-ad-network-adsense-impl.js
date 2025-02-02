/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Because AdSense and DoubleClick are both operated by Google and their A4A
// implementations share some behavior in common, part of the logic for this
// implementation is located in the ads/google/a4a directory rather than here.
// Most other ad networks will want to put their A4A code entirely in the
// extensions/amp-ad-network-${NETWORK_NAME}-impl directory.

import {AdsenseSharedState} from './adsense-shared-state';
import {AmpA4A} from '../../amp-a4a/0.1/amp-a4a';
import {CONSENT_POLICY_STATE} from '../../../src/consent-state';
import {FIE_CSS_CLEANUP_EXP} from '../../../src/friendly-iframe-embed';
import {Navigation} from '../../../src/service/navigation';
import {
  QQID_HEADER,
  SANDBOX_HEADER,
  ValidAdContainerTypes,
  addCsiSignalsToAmpAnalyticsConfig,
  additionalDimensions,
  extractAmpAnalyticsConfig,
  getCsiAmpAnalyticsConfig,
  getCsiAmpAnalyticsVariables,
  getEnclosingContainerTypes,
  getIdentityToken,
  googleAdUrl,
  isCdnProxy,
  isReportingEnabled,
  maybeAppendErrorParameter,
} from '../../../ads/google/a4a/utils';
import {ResponsiveState} from './responsive-state';
import {Services} from '../../../src/services';
import {
  addExperimentIdToElement,
  isInManualExperiment,
} from '../../../ads/google/a4a/traffic-experiments';
import {computedStyle, setStyles} from '../../../src/style';
import {dev, devAssert, user} from '../../../src/log';
import {domFingerprintPlain} from '../../../src/utils/dom-fingerprint';
import {getAmpAdRenderOutsideViewport} from '../../amp-ad/0.1/concurrent-load';
import {getData} from '../../../src/event-helper';
import {getDefaultBootstrapBaseUrl} from '../../../src/3p-frame';
import {
  getExperimentBranch,
  randomlySelectUnsetExperiments,
} from '../../../src/experiments';
import {getMode} from '../../../src/mode';
import {insertAnalyticsElement} from '../../../src/extension-analytics';
import {removeElement} from '../../../src/dom';
import {stringHash32} from '../../../src/string';
import {utf8Decode} from '../../../src/utils/bytes';

/** @const {string} */
const ADSENSE_BASE_URL = 'https://googleads.g.doubleclick.net/pagead/ads';

/** @const {string} */
const TAG = 'amp-ad-network-adsense-impl';

/**
 * Shared state for AdSense ad slots. This is used primarily for ad request url
 * parameters that depend on previous slots.
 * @const {!AdsenseSharedState}
 */
const sharedState = new AdsenseSharedState();

/** @visibleForTesting */
export function resetSharedState() {
  sharedState.reset();
}

/** @type {string} */
const FORMAT_EXP = 'as-use-attr-for-format';

/** @final */
export class AmpAdNetworkAdsenseImpl extends AmpA4A {
  /**
   * @param {!Element} element
   */
  constructor(element) {
    super(element);

    /**
     * A unique identifier for this slot.
     * Not initialized until getAdUrl() is called; updated upon each invocation
     * of getAdUrl().
     * @private {?string}

     */
    this.uniqueSlotId_ = null;

    /**
     * Config to generate amp-analytics element for active view reporting.
     * @type {?JsonObject}
     * @private
     */
    this.ampAnalyticsConfig_ = null;

    /** @private {!../../../src/service/extensions-impl.Extensions} */
    this.extensions_ = Services.extensionsFor(this.win);

    /** @private {?({width, height}|../../../src/layout-rect.LayoutRectDef)} */
    this.size_ = null;

    /**
     * amp-analytics element generated based on this.ampAnalyticsConfig_
     * @private {?Element}
     */
    this.ampAnalyticsElement_ = null;

    /** @private {?string} */
    this.qqid_ = null;

    /** @private {?ResponsiveState}.  */
    this.responsiveState_ = ResponsiveState.createIfResponsive(element);

    /** @private {?Promise<!../../../ads/google/a4a/utils.IdentityToken>} */
    this.identityTokenPromise_ = null;

    /**
     * @private {?boolean} whether preferential rendered AMP creative, null
     * indicates no creative render.
     */
    this.isAmpCreative_ = null;

    /** @private {number} slot index specific to google inventory */
    this.ifi_ = 0;

    /**
     * Whether or not the iframe containing the ad should be sandboxed via the
     * "sandbox" attribute.
     * @private {boolean}
     */
    this.shouldSandbox_ = false;
  }

  /** @override */
  isValidElement() {
    /**
     * isValidElement used to also check that we are in a valid A4A environment,
     * however this is not necessary as that is checked by adsenseIsA4AEnabled,
     * which is always called as part of the upgrade path from an amp-ad element
     * to an amp-ad-adsense element. Thus, if we are an amp-ad, we can be sure
     * that it has been verified.
     */
    if (
      this.responsiveState_ != null &&
      !this.responsiveState_.isValidElement()
    ) {
      return false;
    }
    if (!this.element.getAttribute('data-ad-client')) {
      return false;
    }
    return this.isAmpAdElement();
  }

  /** @override */
  delayAdRequestEnabled() {
    return getAmpAdRenderOutsideViewport(this.element) || 3;
  }

  /** @override */
  buildCallback() {
    super.buildCallback();
    this.identityTokenPromise_ = this.getAmpDoc()
      .whenFirstVisible()
      .then(() =>
        getIdentityToken(this.win, this.getAmpDoc(), super.getConsentPolicy())
      );

    if (this.responsiveState_ != null) {
      return this.responsiveState_.attemptChangeSize();
    }
    // This should happen last, as some diversion criteria rely on some of the
    // preceding logic (specifically responsive logic).
    this.divertExperiments();
    this.maybeAddSinglePassExperiment();
  }

  /** @override */
  getConsentPolicy() {
    // Ensure that build is not blocked by need for consent (delay will occur
    // prior to ad URL construction).
    return null;
  }

  /**
   * Selects into experiments based on url fragment and/or page level diversion.
   * @visibleForTesting
   */
  divertExperiments() {
    const experimentInfoMap = /** @type {!Object<string,
        !../../../src/experiments.ExperimentInfo>} */ ({
      [FORMAT_EXP]: {
        isTrafficEligible: () =>
          !this.responsiveState_ &&
          Number(this.element.getAttribute('width')) > 0 &&
          Number(this.element.getAttribute('height')) > 0,
        branches: ['21062003', '21062004'],
      },
      [[FIE_CSS_CLEANUP_EXP.branch]]: {
        isTrafficEligible: () => true,
        branches: [
          [FIE_CSS_CLEANUP_EXP.control],
          [FIE_CSS_CLEANUP_EXP.experiment],
        ],
      },
    });
    const setExps = randomlySelectUnsetExperiments(this.win, experimentInfoMap);
    Object.keys(setExps).forEach(expName =>
      addExperimentIdToElement(setExps[expName], this.element)
    );
  }

  /** @override */
  getAdUrl(consentState) {
    if (
      consentState == CONSENT_POLICY_STATE.UNKNOWN &&
      this.element.getAttribute('data-npa-on-unknown-consent') != 'true'
    ) {
      user().info(TAG, 'Ad request suppressed due to unknown consent');
      return Promise.resolve('');
    }
    // TODO: Check for required and allowed parameters. Probably use
    // validateData, from 3p/3p/js, after moving it someplace common.
    const startTime = Date.now();
    const global = this.win;
    let adClientId = this.element.getAttribute('data-ad-client');
    // Ensure client id format: lower case with 'ca-' prefix.
    adClientId = adClientId.toLowerCase();
    if (adClientId.substring(0, 3) != 'ca-') {
      adClientId = 'ca-' + adClientId;
    }
    const adTestOn =
      this.element.getAttribute('data-adtest') ||
      isInManualExperiment(this.element);
    const width = Number(this.element.getAttribute('width'));
    const height = Number(this.element.getAttribute('height'));

    this.size_ =
      getExperimentBranch(this.win, FORMAT_EXP) == '21062004'
        ? {width, height}
        : this.getIntersectionElementLayoutBox();
    const sizeToSend = this.isSinglePageStoryAd
      ? {width: 1, height: 1}
      : this.size_;
    const format = `${sizeToSend.width}x${sizeToSend.height}`;
    const slotId = this.element.getAttribute('data-amp-slot-index');
    // data-amp-slot-index is set by the upgradeCallback method of amp-ad.
    // TODO(bcassels): Uncomment the assertion, fixing the tests.
    // But not all tests arrange to call upgradeCallback.
    // devAssert(slotId != undefined);
    const adk = this.adKey_(format);
    this.uniqueSlotId_ = slotId + adk;
    const slotname = this.element.getAttribute('data-ad-slot');
    const sharedStateParams = sharedState.addNewSlot(
      format,
      this.uniqueSlotId_,
      adClientId,
      slotname
    );
    const viewportSize = this.getViewport().getSize();
    if (!this.ifi_) {
      this.win['ampAdGoogleIfiCounter'] =
        this.win['ampAdGoogleIfiCounter'] || 1;
      this.ifi_ = this.win['ampAdGoogleIfiCounter']++;
    }
    const enclosingContainers = getEnclosingContainerTypes(this.element);
    const pfx =
      enclosingContainers.includes(
        ValidAdContainerTypes['AMP-FX-FLYING-CARPET']
      ) || enclosingContainers.includes(ValidAdContainerTypes['AMP-STICKY-AD']);
    const parameters = {
      'client': adClientId,
      'format': format,
      'w': sizeToSend.width,
      'h': sizeToSend.height,
      'iu': slotname,
      'npa':
        consentState == CONSENT_POLICY_STATE.INSUFFICIENT ||
        consentState == CONSENT_POLICY_STATE.UNKNOWN
          ? 1
          : null,
      'adtest': adTestOn ? 'on' : null,
      'adk': adk,
      'output': 'html',
      'bc': global.SVGElement && global.document.createElementNS ? '1' : null,
      'ctypes': this.getCtypes_(),
      'host': this.element.getAttribute('data-ad-host'),
      'hl': this.element.getAttribute('data-language'),
      'to': this.element.getAttribute('data-tag-origin'),
      'pv': sharedStateParams.pv,
      'channel': this.element.getAttribute('data-ad-channel'),
      'wgl': global['WebGLRenderingContext'] ? '1' : '0',
      'asnt': this.sentinel,
      'dff': computedStyle(this.win, this.element)['font-family'],
      'prev_fmts': sharedStateParams.prevFmts || null,
      'prev_slotnames': sharedStateParams.prevSlotnames || null,
      'brdim': additionalDimensions(this.win, viewportSize),
      'ifi': this.ifi_,
      'rc': this.fromResumeCallback ? 1 : null,
      'rafmt':
        this.responsiveState_ != null
          ? this.responsiveState_.getRafmtParam()
          : null,
      'pfx': pfx ? '1' : '0',
      'aanf': /^(true|false)$/i.test(this.element.getAttribute('data-no-fill'))
        ? this.element.getAttribute('data-no-fill')
        : null,
      // Matched content specific fields.
      'crui': this.element.getAttribute('data-matched-content-ui-type'),
      'cr_row': this.element.getAttribute('data-matched-content-rows-num'),
      'cr_col': this.element.getAttribute('data-matched-content-columns-num'),
      // Package code (also known as URL group) that was used to
      // create ad.
      'pwprc': this.element.getAttribute('data-package'),
      'spsa': this.isSinglePageStoryAd
        ? `${viewportSize.width}x${viewportSize.height}`
        : null,
    };

    const experimentIds = [];
    const identityPromise = Services.timerFor(this.win)
      .timeoutPromise(1000, this.identityTokenPromise_)
      .catch(unusedErr => {
        // On error/timeout, proceed.
        return /**@type {!../../../ads/google/a4a/utils.IdentityToken}*/ ({});
      });
    return identityPromise.then(identity => {
      return googleAdUrl(
        this,
        ADSENSE_BASE_URL,
        startTime,
        Object.assign(
          {
            'adsid': identity.token || null,
            'jar': identity.jar || null,
            'pucrd': identity.pucrd || null,
          },
          parameters
        ),
        experimentIds
      );
    });
  }

  /** @override */
  onNetworkFailure(error, adUrl) {
    dev().info(TAG, 'network error, attempt adding of error parameter', error);
    return {adUrl: maybeAppendErrorParameter(adUrl, 'n')};
  }

  /** @override */
  maybeValidateAmpCreative(bytes, headers) {
    if (headers.get('AMP-Verification-Checksum-Algorithm') !== 'djb2a-32') {
      return super.maybeValidateAmpCreative(bytes, headers);
    }
    const checksum = headers.get('AMP-Verification-Checksum');
    return Promise.resolve(
      checksum && stringHash32(utf8Decode(bytes)) == checksum ? bytes : null
    );
  }

  /** @override */
  extractSize(responseHeaders) {
    this.ampAnalyticsConfig_ = extractAmpAnalyticsConfig(this, responseHeaders);
    this.qqid_ = responseHeaders.get(QQID_HEADER);
    this.shouldSandbox_ = responseHeaders.get(SANDBOX_HEADER) == 'true';
    if (this.ampAnalyticsConfig_) {
      // Load amp-analytics extensions
      this.extensions_./*OK*/ installExtensionForDoc(
        this.getAmpDoc(),
        'amp-analytics'
      );
    }
    return this.size_;
  }

  /**
   * @param {string} format
   * @return {string} The ad unit hash key string.
   * @private
   */
  adKey_(format) {
    const {element} = this;
    const slot = element.getAttribute('data-ad-slot') || '';
    const string = `${slot}:${format}:${domFingerprintPlain(element)}`;
    return stringHash32(string);
  }

  /**
   * @return {?string}
   * @private
   */
  getCtypes_() {
    if (!getMode().localDev) {
      return null;
    }
    const ctypesReMatch = /[?&]force_a4a_ctypes=([^&]+)/.exec(
      this.win.location.search
    );
    // If the RE passes, then length is necessarily > 1.
    if (ctypesReMatch) {
      return ctypesReMatch[1];
    }
    return null;
  }

  /** @override */
  isXhrAllowed() {
    return isCdnProxy(this.win);
  }

  /** @override */
  sandboxHTMLCreativeFrame() {
    return this.shouldSandbox_;
  }

  /** @override */
  onCreativeRender(creativeMetaData) {
    super.onCreativeRender(creativeMetaData);
    this.isAmpCreative_ = !!creativeMetaData;
    if (
      creativeMetaData &&
      !creativeMetaData.customElementExtensions.includes('amp-ad-exit')
    ) {
      // Capture phase click handlers on the ad if amp-ad-exit not present
      // (assume it will handle capture).
      devAssert(this.iframe);
      Navigation.installAnchorClickInterceptor(
        this.getAmpDoc(),
        devAssert(this.iframe.contentWindow)
      );
    }
    if (this.ampAnalyticsConfig_) {
      devAssert(!this.ampAnalyticsElement_);
      if (isReportingEnabled(this)) {
        addCsiSignalsToAmpAnalyticsConfig(
          this.win,
          this.element,
          this.ampAnalyticsConfig_,
          this.qqid_,
          !!creativeMetaData
        );
      }
      this.ampAnalyticsElement_ = insertAnalyticsElement(
        this.element,
        this.ampAnalyticsConfig_,
        /*loadAnalytics*/ true,
        !!this.postAdResponseExperimentFeatures['avr_disable_immediate']
      );
    }

    setStyles(dev().assertElement(this.iframe), {
      width: `${this.size_.width}px`,
      height: `${this.size_.height}px`,
    });
    if (this.qqid_) {
      this.element.setAttribute('data-google-query-id', this.qqid_);
    }
    dev().assertElement(this.iframe).id = `google_ads_iframe_${this.ifi_}`;
  }

  /** @override */
  unlayoutCallback() {
    if (this.isAmpCreative_) {
      // Allow AMP creatives to remain in case SERP viewer swipe back.
      return false;
    }
    const superResult = super.unlayoutCallback();
    this.element.setAttribute(
      'data-amp-slot-index',
      this.win.ampAdSlotIdCounter++
    );
    if (this.uniqueSlotId_) {
      sharedState.removeSlot(this.uniqueSlotId_);
    }
    if (this.ampAnalyticsElement_) {
      removeElement(this.ampAnalyticsElement_);
      this.ampAnalyticsElement_ = null;
    }
    this.ampAnalyticsConfig_ = null;
    this.qqid_ = null;
    this.isAmpCreative_ = null;
    this.shouldSandbox_ = false;
    return superResult;
  }

  /** @override */
  onLayoutMeasure() {
    super.onLayoutMeasure();
    this.responsiveState_ && this.responsiveState_.alignToViewport();
  }

  /** @override */
  getPreconnectUrls() {
    this.preconnect.preload(getDefaultBootstrapBaseUrl(this.win, 'nameframe'));
    return ['https://googleads.g.doubleclick.net'];
  }

  /** @override */
  getA4aAnalyticsVars(analyticsTrigger) {
    return getCsiAmpAnalyticsVariables(analyticsTrigger, this, this.qqid_);
  }

  /** @override */
  getA4aAnalyticsConfig() {
    return getCsiAmpAnalyticsConfig();
  }

  /** @override */
  letCreativeTriggerRenderStart() {
    if (
      this.element &&
      this.element.parentElement &&
      this.element.parentElement.tagName == 'AMP-STICKY-AD'
    ) {
      const stickyMsgListener = event => {
        if (
          getData(event) == 'fill_sticky' &&
          event['source'] == this.iframe.contentWindow
        ) {
          this.renderStarted();
          this.iframe.setAttribute('visible', '');
          this.win.removeEventListener('message', stickyMsgListener);
        }
      };
      this.win.addEventListener('message', stickyMsgListener);
      return true;
    }
    return false;
  }
}

AMP.extension(TAG, '0.1', AMP => {
  AMP.registerElement(TAG, AmpAdNetworkAdsenseImpl);
});
