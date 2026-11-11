// ---------------------------------------------------------------------------
// The production reads behind Sophie's situation brief: the same gateway
// routes her tools call (as the person, on their org), plus billing's payment
// outlook, read where the dashboard reads it (the gateway does not serve it).
// ---------------------------------------------------------------------------

import type { ApiCallParams } from "../lib/api-client.js";
import { getPaymentOutlook } from "../lib/billing-client.js";
import { getBillingAccount, getCampaignNextSteps, getOfferPerformance, listOffers, listRepliesToHandle } from "../lib/account-client.js";
import { getOfferSettings } from "../lib/copilot-client.js";
import { listAccountCampaigns } from "../lib/funnel-campaign-client.js";
import { listBrands } from "../lib/funnel-client.js";
import type { SituationReader } from "./situation.js";

export function gatewaySituationReader(params: ApiCallParams): SituationReader {
  return {
    listBrands: () => listBrands(params),
    listOffers: (brandId) => listOffers(brandId, params),
    getOfferSettings: (brandId, offerId) => getOfferSettings({ brandId, offerId }, params),
    listCampaigns: (brandId) => listAccountCampaigns({ brandId }, params),
    getOfferPerformance: (brandId, offerId) => getOfferPerformance({ brandId, offerId, windowDays: "all" }, params),
    listRepliesToHandle: (brandId, offerId) => listRepliesToHandle({ brandId, offerId }, params),
    getBillingAccount: () => getBillingAccount(params),
    getPaymentOutlook: () => getPaymentOutlook(params.orgId),
    getCampaignNextSteps: (brandId, campaignId) => getCampaignNextSteps({ brandId, campaignId }, params),
  };
}
