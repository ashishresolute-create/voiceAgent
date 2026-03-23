// src/scheduling/tools.ts
import type Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import { addDays, startOfDay, endOfDay, isPast, parseISO } from './dateUtils';
import type { PatientContext } from '../agent/orchestrator';

const prisma = new PrismaClient();

// ─── Tool definitions (Anthropic format) ──────────────────────────────────────

export const appointmentTools: Anthropic.Tool[] = [
  {
    name: 'check_available_slots',
    description:
      'Check available appointment slots for a specific doctor or specialty on a given date range.',
    input_schema: {
      type: 'object',
      properties: {
        doctor_name: { type: 'string', description: 'Name of the doctor (optional)' },
        specialty: { type: 'string', description: 'Medical specialty (optional)' },
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format, or "today", "tomorrow", "next week"',
        },
        limit: { type: 'number', description: 'Max slots to return (default 5)' },
      },
      required: [],
    },
  },
  {
    name: 'book_appointment',
    description: 'Book an appointment for the patient in a specific slot.',
    input_schema: {
      type: 'object',
      properties: {
        slot_id: { type: 'string', description: 'The slot ID from check_available_slots' },
        reason: { type: 'string', description: 'Reason for the appointment' },
        patient_name: { type: 'string', description: 'Patient name if not already known' },
      },
      required: ['slot_id'],
    },
  },
  {
    name: 'list_patient_appointments',
    description: 'List upcoming appointments for the current patient.',
    input_schema: {
      type: 'object',
      properties: {
        include_past: { type: 'boolean', description: 'Include past appointments too' },
      },
      required: [],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an existing appointment.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'The appointment ID to cancel' },
        reason: { type: 'string', description: 'Reason for cancellation (optional)' },
      },
      required: ['appointment_id'],
    },
  },
  {
    name: 'reschedule_appointment',
    description: 'Reschedule an existing appointment to a new slot.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: {
          type: 'string',
          description: 'The existing appointment ID to reschedule',
        },
        new_slot_id: { type: 'string', description: 'New slot ID from check_available_slots' },
      },
      required: ['appointment_id', 'new_slot_id'],
    },
  },
  {
    name: 'find_alternative_slots',
    description:
      'When a requested slot is unavailable, find the next available alternatives for the same doctor or specialty.',
    input_schema: {
      type: 'object',
      properties: {
        doctor_name: { type: 'string' },
        specialty: { type: 'string' },
        preferred_date: { type: 'string', description: 'YYYY-MM-DD' },
        count: { type: 'number', description: 'Number of alternatives (default 3)' },
      },
      required: [],
    },
  },
  {
    name: 'list_doctors',
    description: 'List available doctors, optionally filtered by specialty.',
    input_schema: {
      type: 'object',
      properties: {
        specialty: { type: 'string', description: 'Filter by specialty' },
      },
      required: [],
    },
  },
];

// ─── Tool execution ────────────────────────────────────────────────────────────

export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  patientContext: PatientContext | null
): Promise<unknown> {
  switch (name) {
    case 'check_available_slots':
      return checkAvailableSlots(input, patientContext);
    case 'book_appointment':
      return bookAppointment(input, patientContext);
    case 'list_patient_appointments':
      return listPatientAppointments(input, patientContext);
    case 'cancel_appointment':
      return cancelAppointment(input, patientContext);
    case 'reschedule_appointment':
      return rescheduleAppointment(input, patientContext);
    case 'find_alternative_slots':
      return findAlternativeSlots(input, patientContext);
    case 'list_doctors':
      return listDoctors(input);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function checkAvailableSlots(
  input: Record<string, unknown>,
  _ctx: PatientContext | null
) {
  const { doctor_name, specialty, date, limit = 5 } = input as {
    doctor_name?: string;
    specialty?: string;
    date?: string;
    limit?: number;
  };

  let targetDate = new Date();
  if (date === 'tomorrow') targetDate = addDays(targetDate, 1);
  else if (date === 'next week') targetDate = addDays(targetDate, 7);
  else if (date && date !== 'today') targetDate = parseISO(date);

  const slots = await prisma.slot.findMany({
    where: {
      isBooked: false,
      startTime: {
        gte: startOfDay(targetDate),
        lte: endOfDay(addDays(targetDate, 7)),
      },
      doctor: {
        ...(doctor_name ? { name: { contains: doctor_name, mode: 'insensitive' } } : {}),
        ...(specialty ? { specialty: { contains: specialty, mode: 'insensitive' } } : {}),
      },
    },
    include: { doctor: true },
    orderBy: { startTime: 'asc' },
    take: Number(limit),
  });

  return slots.map((s) => ({
    slot_id: s.id,
    doctor: s.doctor.name,
    specialty: s.doctor.specialty,
    date: s.startTime.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }),
    time: s.startTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    duration_minutes: Math.round((s.endTime.getTime() - s.startTime.getTime()) / 60000),
  }));
}

async function bookAppointment(
  input: Record<string, unknown>,
  ctx: PatientContext | null
) {
  const { slot_id, reason } = input as { slot_id: string; reason?: string };

  if (!ctx?.patientId) {
    return { success: false, error: 'Patient identity not confirmed. Please provide your name.' };
  }

  // Check slot is still free (prevent race condition)
  const slot = await prisma.slot.findUnique({ where: { id: slot_id } });
  if (!slot || slot.isBooked) {
    return { success: false, error: 'Slot no longer available. Please choose another.' };
  }

  if (isPast(slot.startTime)) {
    return { success: false, error: 'Cannot book a past time slot.' };
  }

  const [, appointment] = await prisma.$transaction([
    prisma.slot.update({ where: { id: slot_id }, data: { isBooked: true } }),
    prisma.appointment.create({
      data: {
        patientId: ctx.patientId,
        doctorId: slot.doctorId,
        slotId: slot_id,
        reason: reason ?? '',
        status: 'CONFIRMED',
      },
      include: { doctor: true, slot: true },
    }),
  ]);

  return {
    success: true,
    appointment_id: appointment.id,
    confirmation: `Appointment confirmed with ${appointment.doctor.name} on ${appointment.slot.startTime.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} at ${appointment.slot.startTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.`,
  };
}

async function listPatientAppointments(
  input: Record<string, unknown>,
  ctx: PatientContext | null
) {
  if (!ctx?.patientId) return { appointments: [], message: 'Patient not identified.' };

  const { include_past = false } = input as { include_past?: boolean };

  const appointments = await prisma.appointment.findMany({
    where: {
      patientId: ctx.patientId,
      status: { notIn: ['CANCELLED'] },
      ...(include_past ? {} : { slot: { startTime: { gte: new Date() } } }),
    },
    include: { doctor: true, slot: true },
    orderBy: { slot: { startTime: 'asc' } },
  });

  return appointments.map((a) => ({
    appointment_id: a.id,
    doctor: a.doctor.name,
    specialty: a.doctor.specialty,
    date: a.slot.startTime.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }),
    time: a.slot.startTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    status: a.status,
    reason: a.reason,
  }));
}

async function cancelAppointment(
  input: Record<string, unknown>,
  ctx: PatientContext | null
) {
  const { appointment_id, reason } = input as { appointment_id: string; reason?: string };

  const appointment = await prisma.appointment.findFirst({
    where: { id: appointment_id, patientId: ctx?.patientId ?? undefined },
    include: { slot: true },
  });

  if (!appointment) return { success: false, error: 'Appointment not found.' };
  if (appointment.status === 'CANCELLED') return { success: false, error: 'Already cancelled.' };

  await prisma.$transaction([
    prisma.appointment.update({
      where: { id: appointment_id },
      data: { status: 'CANCELLED', notes: reason },
    }),
    prisma.slot.update({ where: { id: appointment.slotId }, data: { isBooked: false } }),
  ]);

  return { success: true, message: 'Appointment cancelled successfully.' };
}

async function rescheduleAppointment(
  input: Record<string, unknown>,
  ctx: PatientContext | null
) {
  const { appointment_id, new_slot_id } = input as {
    appointment_id: string;
    new_slot_id: string;
  };

  const [old, newSlot] = await Promise.all([
    prisma.appointment.findFirst({
      where: { id: appointment_id, patientId: ctx?.patientId ?? undefined },
    }),
    prisma.slot.findUnique({ where: { id: new_slot_id } }),
  ]);

  if (!old) return { success: false, error: 'Original appointment not found.' };
  if (!newSlot || newSlot.isBooked) return { success: false, error: 'New slot is not available.' };

  await prisma.$transaction([
    prisma.slot.update({ where: { id: old.slotId }, data: { isBooked: false } }),
    prisma.slot.update({ where: { id: new_slot_id }, data: { isBooked: true } }),
    prisma.appointment.update({
      where: { id: appointment_id },
      data: { slotId: new_slot_id, status: 'RESCHEDULED' },
    }),
  ]);

  const updated = await prisma.appointment.findUnique({
    where: { id: appointment_id },
    include: { doctor: true, slot: true },
  });

  return {
    success: true,
    confirmation: updated
      ? `Rescheduled to ${updated.slot.startTime.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} at ${updated.slot.startTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.`
      : 'Rescheduled.',
  };
}

async function findAlternativeSlots(
  input: Record<string, unknown>,
  _ctx: PatientContext | null
) {
  const { doctor_name, specialty, preferred_date, count = 3 } = input as {
    doctor_name?: string;
    specialty?: string;
    preferred_date?: string;
    count?: number;
  };

  const base = preferred_date ? parseISO(preferred_date) : new Date();

  const slots = await prisma.slot.findMany({
    where: {
      isBooked: false,
      startTime: { gte: base },
      doctor: {
        ...(doctor_name ? { name: { contains: doctor_name, mode: 'insensitive' } } : {}),
        ...(specialty ? { specialty: { contains: specialty, mode: 'insensitive' } } : {}),
      },
    },
    include: { doctor: true },
    orderBy: { startTime: 'asc' },
    take: Number(count),
  });

  return slots.map((s) => ({
    slot_id: s.id,
    doctor: s.doctor.name,
    date: s.startTime.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }),
    time: s.startTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
  }));
}

async function listDoctors(input: Record<string, unknown>) {
  const { specialty } = input as { specialty?: string };

  const doctors = await prisma.doctor.findMany({
    where: specialty ? { specialty: { contains: specialty, mode: 'insensitive' } } : {},
    orderBy: { name: 'asc' },
  });

  return doctors.map((d) => ({ name: d.name, specialty: d.specialty }));
}
