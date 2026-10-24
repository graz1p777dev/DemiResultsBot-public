from functools import lru_cache

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
    )

    app_env: str = "production"
    api_title: str = "Demi Results AI Bot"
    database_url: str = "postgresql+psycopg://demi:demi@postgres:5432/demi_results"
    redis_url: str = "redis://redis:6379/0"
    cors_origins: str = "http://localhost:3000"
    webhook_rate_limit_per_minute: int = 120
    message_buffer_seconds: int = 10

    openai_api_key: str = ""
    openai_asr_api_key: str = ""
    openai_asr_model: str = "gpt-transcribe"
    openai_model: str = "gpt-4.1-mini"
    openai_extractor_model: str = "gpt-4.1-mini"
    # Two-tier reply model routing: simple questions vs active sales/objections
    openai_model_simple: str = "gpt-5.1"
    openai_model_sales: str = "gpt-5.5"
    openai_input_cost_simple: float = 1.25
    openai_output_cost_simple: float = 10.0
    openai_input_cost_sales: float = 5.0
    openai_output_cost_sales: float = 30.0
    deepseek_api_key: str = ""
    deepseek_input_cost_per_1m: float = 0.07    # deepseek-chat v3 pricing
    deepseek_output_cost_per_1m: float = 1.10
    gemini_api_key: str = ""

    # AI Copilot ("ИИ-помощник") — read-only access to the inventory Supabase project
    copilot_openai_model: str = "gpt-5.1"
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    # Extractor/utility model pricing (gpt-4.1-mini or similar)
    openai_input_cost_extractor: float = 0.40
    openai_output_cost_extractor: float = 1.60
    # Legacy fallback — kept for backward compat, now equals extractor pricing
    openai_input_cost_per_1m_tokens: float = 0.40
    openai_output_cost_per_1m_tokens: float = 1.60

    amocrm_base_url: str = "https://example.amocrm.ru"
    amocrm_access_token: str = ""
    amocrm_webhook_secret: str = ""
    amojo_base_url: str = "https://amojo.amocrm.ru"
    amocrm_ai_user_id: int = 0  # amoCRM user ID for "ИИ Агент" — assigned as responsible when bot takes a lead

    google_sheets_enabled: bool = False
    google_service_account_json: str = ""
    google_service_account_file: str = ""
    google_sheets_spreadsheet_id: str = ""

    timezone: str = "Asia/Bishkek"
    schedule_start_dates: str = "2026-05-19,2026-05-20"
    consultation_start_hour: int = 10
    consultation_end_hour: int = 21
    consultation_interval_minutes: int = 20
    do_not_offer_today_after_hour: int = 18

    admin_api_key: str = Field(default="", description="Optional API key for admin routes.")
    jwt_secret: str = Field(default="change-me-in-production", description="Secret for JWT signing.")
    human_approval_enabled: bool = True
    reply_hours_enabled: bool = True
    reply_start_hour: int = Field(default=10, ge=0, le=22)
    reply_end_hour: int = Field(default=21, ge=1, le=23)
    telegram_bot_token: str = ""
    telegram_manager_chat_id: str = ""
    telegram_extra_manager_chat_ids: str = ""
    telegram_allowed_manager_ids: str = ""
    telegram_webhook_secret: str = ""
    public_backend_url: str = ""
    frontend_url: str = "https://crm.example.invalid"
    # Пусто по умолчанию → crm_notify.notify() тихо ничего не делает.
    crm_notify_url: str = "https://crm.example.invalid/api/internal/notify"
    crm_deals_url: str = "https://crm.example.invalid/api/internal/deals"
    crm_consultations_url: str = "https://crm.example.invalid/api/internal/consultations"
    crm_channel_send_url: str = "https://crm.example.invalid/api/internal/channel-send"
    crm_notify_token: str = ""
    amocrm_status_on_approve: int | None = None
    amocrm_status_on_edit: int | None = None
    amocrm_status_on_reject: int | None = None
    amocrm_status_on_save: int | None = None
    amocrm_status_primary_contact: int | None = None
    amocrm_status_qualified: int | None = None
    amocrm_status_consultation_scheduled: int | None = None
    amocrm_status_unsorted: int | None = None
    amocrm_status_purchase: int | None = None  # stage for 'wants to buy' leads
    green_api_url: str = ""
    green_api_id_instance: str = ""
    green_api_token_instance: str = ""

    @model_validator(mode="after")
    def validate_reply_hours(self):
        if self.reply_start_hour >= self.reply_end_hour:
            raise ValueError("reply_start_hour must be earlier than reply_end_hour")
        return self

    @field_validator("database_url")
    @classmethod
    def normalize_database_url(cls, value: str) -> str:
        if value.startswith("postgres://"):
            return value.replace("postgres://", "postgresql+psycopg://", 1)
        if value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg://", 1)
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
