from typing import Literal

from pydantic import BaseModel, Field, field_validator


class DoseSlot(BaseModel):
    """
    One expected administration time in the patient's local calendar.

    - time_local: HH:MM (24h) in the medication's timezone
    - days_of_week: 0=Monday … 6=Sunday (same as datetime.weekday()); omit or empty = every day
    """

    time_local: str = Field(..., pattern=r"^\d{2}:\d{2}$", examples=["08:00", "21:30"])
    days_of_week: list[int] | None = Field(
        default=None,
        description="If null or omitted, interpreted as all seven days.",
    )

    @field_validator("days_of_week")
    @classmethod
    def validate_dow(cls, v: list[int] | None) -> list[int] | None:
        if v is None:
            return v
        for d in v:
            if d < 0 or d > 6:
                raise ValueError("days_of_week values must be 0–6 (Mon–Sun)")
        return v


class MedicationSchedule(BaseModel):
    medication_id: str = Field(..., min_length=1, max_length=128)
    display_name: str | None = None
    timezone: str = Field(
        ...,
        description="IANA timezone for interpreting time_local (e.g. America/New_York).",
        examples=["America/New_York", "Europe/London"],
    )
    instructions: str | None = Field(default=None, description="SIG / patient-facing directions.")
    doses: list[DoseSlot] = Field(default_factory=list, min_length=1)


class PrescriptionSchedulePayload(BaseModel):
    """Full schedule document stored on prescription_schedule_set events."""

    version: Literal[1] = 1
    source: str | None = Field(default=None, description="e.g. ehr_import | patient_entered | pharmacy")
    medications: list[MedicationSchedule] = Field(min_length=1)
