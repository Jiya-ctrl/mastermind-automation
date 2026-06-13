"""WhatsApp delivery provider abstraction.

Each provider implements a single method, ``send(delivery)``, and returns a
uniform result dict. New providers (Twilio, WhatsApp Cloud API, Gupshup,
Wati, etc.) drop into the registry at the bottom of this file without any
change to the delivery worker.

This file deliberately has zero Flask / business-logic dependencies — it is
import-safe from tests and CLI utilities.
"""

from __future__ import annotations

import abc
import random
import time
import uuid


class BaseProvider(abc.ABC):
    """A WhatsApp-style media-message provider.

    Implementations must be thread-safe: the worker may call ``send`` from a
    background thread while routes read provider metadata from the request
    thread.
    """

    #: Short identifier persisted on each delivery record.
    name: str = "base"

    @abc.abstractmethod
    def send(self, delivery: dict) -> dict:
        """Attempt to send a single delivery.

        Args:
            delivery: A delivery record dict. Required keys:
                ``recipient_phone``, ``video_filename`` (the generated MP4
                basename relative to ``output/videos/``), ``image_filename``
                (basename relative to ``output/images/``), and the joined
                ``recipient_name`` / ``recipient_address`` for any provider
                that wants to render a caption.

        Returns:
            ``{"ok": bool, "provider_message_id": str | None, "error": str | None}``

            * ``ok=True`` means the provider accepted the message for
              delivery; the worker will mark the delivery ``Delivered``.
            * ``ok=False`` means the provider rejected / errored; the worker
              will mark ``Failed`` and capture ``error``.
        """
        raise NotImplementedError


class MockProvider(BaseProvider):
    """Simulated WhatsApp sender. Used until a real provider is plugged in.

    Adds random latency in ``[min_latency_s, max_latency_s]`` and rolls a
    pseudorandom dice for success/failure so the UI can exercise both code
    paths without hitting a real network.
    """

    name = "mock"

    def __init__(
        self,
        success_rate: float = 0.85,
        min_latency_s: float = 0.6,
        max_latency_s: float = 1.8,
        seed: int | None = None,
    ) -> None:
        self.success_rate  = float(success_rate)
        self.min_latency_s = float(min_latency_s)
        self.max_latency_s = float(max_latency_s)
        # A per-provider RNG so unit tests can pin behaviour deterministically.
        self._rng = random.Random(seed)

    def send(self, delivery: dict) -> dict:
        latency = self._rng.uniform(self.min_latency_s, self.max_latency_s)
        time.sleep(latency)
        if self._rng.random() < self.success_rate:
            return {
                "ok":                  True,
                "provider_message_id": f"mock_{uuid.uuid4().hex[:12]}",
                "error":               None,
            }
        return {
            "ok":                  False,
            "provider_message_id": None,
            "error":               "simulated network failure (mock provider)",
        }


class WhatsAppCloudProvider(BaseProvider):
    """Meta WhatsApp Business Cloud API (Graph) provider.

    Sends a media message via POST to:
        https://graph.facebook.com/<v>/<PHONE_NUMBER_ID>/messages

    On success the Graph API returns a `wamid.xxx` provider_message_id.
    This is "Meta accepted the POST" — NOT "the recipient received it".
    The real status (sent / delivered / read / failed) arrives later via
    the webhook (api/app.py:/deliveries/whatsapp-webhook). We therefore
    return `status="Sending"` in our result dict so the worker writes
    `Sending` to the delivery row instead of `Delivered`; the webhook
    promotes the row to `Delivered` (or downgrades to `Failed`) once
    Meta tells us the real outcome.

    Required env / constructor kwargs:
        phone_number_id   — your WhatsApp Business phone-number ID
        access_token      — system-user permanent token or long-lived token
        public_base_url   — full https URL of your /api/ mount, used to
                            absolutize the signed media URL before handing
                            it to Meta's CDN. Example:
                            https://app.mastermind-abacus.com/api

    Optional:
        graph_version     — defaults to v18.0
        timeout_s         — defaults to 15 (Meta usually answers in <1s)
        caption_template  — Python format string with keys
                            {name}, {address}, {phone}. None = no caption.
                            Only used in freeform mode; ignored when a
                            template is in play (template body params are
                            controlled by `template_body_params`).
        media_kind        — "video" (default) or "image"; controls which
                            generated file the delivery sends.

    Template mode (REQUIRED for business-initiated bulk sends):
        WhatsApp's Cloud API only permits freeform messages inside a
        24-hour customer-service window that opens when the user messages
        YOU first. Sending freeform to a cold recipient gets rejected as
        error 131047 ("Re-engagement message") or 131049 ("healthy
        ecosystem engagement"). The fix is to use an approved Marketing
        template with a media header. Operator creates a template once
        per media kind in WhatsApp Manager → Message Templates, sets the
        env var below to the approved name, and the provider switches
        from freeform to template-mode automatically.

        template_image           — approved template name for image sends.
                                   Must have a HEADER of type IMAGE.
        template_video           — approved template name for video sends.
                                   Must have a HEADER of type VIDEO.
        template_lang            — language code (e.g. "en", "en_US").
                                   Must match the language registered with
                                   the template; default "en".
        template_body_params     — list of Python format strings, one per
                                   body placeholder. Available keys:
                                   {name} {address} {phone}. Example:
                                   ["{name}", "{address}"] for a template
                                   whose body reads "Hi {{1}}, …{{2}}…".
                                   None = no body component sent.
    """

    name = "whatsapp"

    def __init__(
        self,
        phone_number_id: str,
        access_token: str,
        public_base_url: str,
        graph_version: str = "v18.0",
        timeout_s: float = 15.0,
        caption_template: str | None = None,
        media_kind: str = "video",
        template_image: str | None = None,
        template_video: str | None = None,
        template_lang: str = "en",
        template_body_params: list[str] | None = None,
    ) -> None:
        if not phone_number_id:
            raise ValueError("WHATSAPP_PHONE_NUMBER_ID is required")
        if not access_token:
            raise ValueError("WHATSAPP_ACCESS_TOKEN is required")
        if not public_base_url:
            raise ValueError("PUBLIC_BASE_URL is required (https URL of /api/)")
        # Imported lazily so the rest of the file stays dependency-free.
        try:
            import requests as _requests  # noqa: PLC0415
        except ImportError as e:
            raise RuntimeError(
                "the 'requests' package is required for the WhatsApp provider"
            ) from e
        self._requests = _requests
        self.phone_number_id  = phone_number_id
        self.access_token     = access_token
        self.public_base_url  = public_base_url.rstrip("/")
        self.graph_version    = graph_version
        self.timeout_s        = float(timeout_s)
        self.caption_template = caption_template
        if media_kind not in ("video", "image"):
            raise ValueError("media_kind must be 'video' or 'image'")
        self.media_kind = media_kind
        self.template_image        = (template_image or "").strip() or None
        self.template_video        = (template_video or "").strip() or None
        self.template_lang         = (template_lang  or "en").strip() or "en"
        self.template_body_params  = list(template_body_params or [])
        # Two-step engagement flow: when configured, send_prompt() ships
        # the lightweight text-only template that asks the recipient to
        # reply. After they do, send() ships the personalised media as a
        # freeform message (allowed inside the 24h customer-service
        # window the inbound reply just opened). Set by the app-layer
        # bootstrap from WHATSAPP_PROMPT_* env / persisted config.
        self.prompt_template       = None
        self.prompt_lang           = self.template_lang
        self.prompt_body_params    = []
        self._endpoint = (
            f"https://graph.facebook.com/{graph_version}"
            f"/{phone_number_id}/messages"
        )

    def _normalise_phone(self, raw: str) -> str:
        """Strip whitespace + leading '+' so Meta accepts the digits-only
        E.164 form. '+91 77700 80900' → '917770080900'."""
        return "".join(c for c in (raw or "") if c.isdigit())

    def _kind_for(self, delivery: dict) -> str:
        """Decide which media half this delivery should ship — per-row
        override first, then constructor default. Lets the Send Media
        dropdown choose Image or Video per batch without restarting."""
        per_row = (delivery.get("media_kind") or "").strip().lower()
        if per_row in ("image", "video"):
            return per_row
        return self.media_kind

    def _media_url_for(self, delivery: dict) -> str | None:
        """Mint a fresh signed URL from the delivery row's `*_filename`
        field and absolutize it.

        Delivery records store basenames only (`video_filename`,
        `image_filename`) — NOT the nested `{url, filename, size}` dict
        that the `/list-generated` cross-join produces. We build the
        signed URL ourselves at send time so the expiry is fresh from
        `MEDIA_URL_TTL_HOURS` even if the delivery has been queued for
        a while.
        """
        kind     = self._kind_for(delivery)
        filename = (delivery.get(f"{kind}_filename") or "").strip()
        if not filename:
            return None
        # Lazy import — keep providers.py free of Flask/session deps at
        # module-load time. By the time the worker calls send(), app.py
        # has already loaded the session module so this is a cache hit.
        import session as _session  # noqa: PLC0415
        path = "/files/videos/" if kind == "video" else "/files/images/"
        rel  = _session.make_signed_url(f"{path}{filename}")
        return f"{self.public_base_url}{rel}"

    def _template_name_for(self, kind: str) -> str | None:
        """Return the approved template configured for this media kind, if any."""
        return self.template_image if kind == "image" else self.template_video

    def _build_template_payload(
        self, to: str, kind: str, media_url: str, delivery: dict, template_name: str
    ) -> dict:
        """Construct a Marketing-template message payload with a media
        header. This is the path that bypasses Meta's 24-hour window
        restriction — required for business-initiated bulk sends to
        cold recipients."""
        header_param = {
            "type": kind,                   # "image" or "video"
            kind:   {"link": media_url},
        }
        components = [{"type": "header", "parameters": [header_param]}]

        # Optional body params, one per {{n}} placeholder in the template
        # body. Operator supplies format-strings via env. If the template
        # has no body placeholders, body_params should be empty.
        if self.template_body_params:
            ctx = {
                "name":    delivery.get("recipient_name") or "",
                "address": delivery.get("recipient_address") or "",
                "phone":   delivery.get("recipient_phone") or "",
            }
            body_params = []
            for fmt in self.template_body_params:
                try:
                    body_params.append({"type": "text", "text": fmt.format(**ctx)})
                except (KeyError, IndexError, AttributeError):
                    body_params.append({"type": "text", "text": ""})
            components.append({"type": "body", "parameters": body_params})

        return {
            "messaging_product": "whatsapp",
            "to":                to,
            "type":              "template",
            "template": {
                "name":       template_name,
                "language":   {"code": self.template_lang},
                "components": components,
            },
        }

    def _build_freeform_payload(
        self, to: str, kind: str, media_url: str, delivery: dict
    ) -> dict:
        """Legacy freeform media payload. Only succeeds inside Meta's
        24-hour customer-service window (i.e. the recipient messaged us
        in the last 24h). Outside that window Meta returns 131047/131049
        — this is the documented cause of the 'healthy ecosystem
        engagement' rejection. Kept for sandbox/test recipients only."""
        # Operator-typed caption takes priority over the config template.
        caption = (delivery.get("operator_caption") or "").strip() or None
        if not caption and self.caption_template:
            try:
                caption = self.caption_template.format(
                    name=delivery.get("recipient_name") or "",
                    address=delivery.get("recipient_address") or "",
                    phone=delivery.get("recipient_phone") or "",
                )
            except (KeyError, IndexError):
                caption = None

        body = {
            "messaging_product": "whatsapp",
            "to":                to,
            "type":              kind,
            kind:                {"link": media_url},
        }
        if caption:
            body[kind]["caption"] = caption
        return body

    def send_prompt(self, delivery: dict) -> dict:
        """Stage 1 of the two-step engagement flow.

        Sends an APPROVED text-only template that asks the recipient to
        reply (e.g. "Hi {{1}}, your media is ready. Reply YES to receive
        it."). The reply opens Meta's 24-hour customer-service window;
        send() can then ship the personalised media as a freeform
        message which Meta won't filter as marketing.

        Reuses the same Graph endpoint + auth as send(), but builds a
        body-only template payload (no media header) so the prompt can
        use ANY approved text-template the operator has registered.
        """
        to = self._normalise_phone(delivery.get("recipient_phone", ""))
        if not to:
            return {"ok": False, "provider_message_id": None,
                    "error": "recipient phone missing or not numeric"}
        if not self.prompt_template:
            return {"ok": False, "provider_message_id": None,
                    "error": "two-step flow requested but WHATSAPP_PROMPT_TEMPLATE not configured"}

        components = []
        if self.prompt_body_params:
            ctx = {
                "name":    delivery.get("recipient_name") or "",
                "address": delivery.get("recipient_address") or "",
                "phone":   delivery.get("recipient_phone") or "",
            }
            body_params = []
            for fmt in self.prompt_body_params:
                try:
                    body_params.append({"type": "text", "text": fmt.format(**ctx)})
                except (KeyError, IndexError, AttributeError):
                    body_params.append({"type": "text", "text": ""})
            components.append({"type": "body", "parameters": body_params})

        payload = {
            "messaging_product": "whatsapp",
            "to":                to,
            "type":              "template",
            "template": {
                "name":       self.prompt_template,
                "language":   {"code": self.prompt_lang or self.template_lang},
                "components": components,
            },
        }
        mode = f"prompt:{self.prompt_template}"
        return self._post_graph(payload, mode, async_status="Awaiting Reply")

    def _post_graph(self, payload: dict, mode: str, async_status: str) -> dict:
        """Shared POST + response parsing for send() and send_prompt().
        `async_status` is the value our internal worker should record as
        the delivery status when Meta accepts the POST (we get a wamid
        back but the real outcome arrives later via the webhook)."""
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type":  "application/json",
        }
        try:
            resp = self._requests.post(
                self._endpoint, json=payload, headers=headers,
                timeout=self.timeout_s,
            )
        except self._requests.exceptions.RequestException as e:
            return {"ok": False, "provider_message_id": None,
                    "error": f"graph API network error ({mode}): {e}"}

        if resp.status_code >= 400:
            try:
                err_obj = resp.json().get("error", {})
                code    = err_obj.get("code")
                msg     = err_obj.get("message") or err_obj.get("code") or resp.text[:300]
                hint = ""
                if code in (131047, 131051) or "Re-engagement" in str(msg):
                    hint = (
                        " | hint: 24h customer-service window expired. "
                        "Configure WHATSAPP_TEMPLATE_IMAGE / _VIDEO with an "
                        "approved template name to bypass."
                    )
                elif code == 131049 or "healthy ecosystem" in str(msg):
                    hint = (
                        " | hint: Meta's quality filter rejected the freeform "
                        "send. Use an approved Marketing template (set "
                        "WHATSAPP_TEMPLATE_IMAGE / _VIDEO) OR switch to the "
                        "two-step flow (WHATSAPP_FLOW=two-step) so the "
                        "recipient opens the 24h window first."
                    )
                elif code == 132000 or "template" in str(msg).lower():
                    hint = (
                        " | hint: template not found OR not approved OR "
                        "language mismatch. Check WhatsApp Manager → "
                        "Message Templates for the exact name + language."
                    )
                msg = f"{msg}{hint}"
            except (ValueError, AttributeError):
                msg = resp.text[:300]
            return {"ok": False, "provider_message_id": None,
                    "error": f"graph HTTP {resp.status_code} ({mode}): {msg}"}

        try:
            data = resp.json()
            wamid = (data.get("messages") or [{}])[0].get("id")
        except (ValueError, IndexError, KeyError):
            wamid = None

        return {
            "ok":                  True,
            "provider_message_id": wamid,
            "error":               None,
            "status":              async_status,
            "send_mode":           mode,
        }

    def send(self, delivery: dict, force_freeform: bool = False) -> dict:
        to = self._normalise_phone(delivery.get("recipient_phone", ""))
        if not to:
            return {"ok": False, "provider_message_id": None,
                    "error": "recipient phone missing or not numeric"}

        # Per-row kind (set when Send Media → Image/Video chooses) wins
        # over the constructor default. This is what lets ONE running
        # provider serve both image AND video deliveries from the same
        # queue without restart.
        kind = self._kind_for(delivery)

        media_url = self._media_url_for(delivery)
        if not media_url:
            return {"ok": False, "provider_message_id": None,
                    "error": f"no signed {kind} URL on delivery row"}

        # When operator typed a custom caption, bypass the template so the
        # caption goes as freeform text. Templates don't support free-text.
        has_caption = bool((delivery.get("operator_caption") or "").strip())
        template_name = None if (force_freeform or has_caption) else self._template_name_for(kind)
        if template_name:
            payload = self._build_template_payload(
                to, kind, media_url, delivery, template_name,
            )
            mode = f"template:{template_name}"
        else:
            payload = self._build_freeform_payload(to, kind, media_url, delivery)
            mode = "freeform-window" if force_freeform else "freeform"

        # `force_freeform` is the stage-2 path in the two-step flow:
        # recipient already replied, we just shipped them the media —
        # mark the row Media Sent until the webhook confirms Delivered.
        async_status = "Media Sent" if force_freeform else "Pending Callback"
        return self._post_graph(payload, mode, async_status=async_status)


# ---------------------------------------------------------------------------
# Registry — add new providers here.
# ---------------------------------------------------------------------------
_REGISTRY: dict[str, type[BaseProvider]] = {
    "mock":     MockProvider,
    "whatsapp": WhatsAppCloudProvider,
}


def get_provider(name: str = "mock", **kwargs) -> BaseProvider:
    """Look up a provider class by name and instantiate it with kwargs."""
    if name not in _REGISTRY:
        raise ValueError(
            f"unknown delivery provider {name!r}; "
            f"registered: {sorted(_REGISTRY)}"
        )
    return _REGISTRY[name](**kwargs)


def list_providers() -> list[str]:
    return sorted(_REGISTRY)
