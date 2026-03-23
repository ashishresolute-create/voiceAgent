// scripts/seed.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { addDays } from '../src/scheduling/dateUtils';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Clear existing data
  await prisma.appointment.deleteMany();
  await prisma.slot.deleteMany();
  await prisma.doctor.deleteMany();
  await prisma.patient.deleteMany();

  // Doctors
  const doctors = await Promise.all([
    prisma.doctor.create({ data: { name: 'Dr. Priya Sharma', specialty: 'General Medicine' } }),
    prisma.doctor.create({ data: { name: 'Dr. Arjun Nair', specialty: 'Cardiology' } }),
    prisma.doctor.create({ data: { name: 'Dr. Meena Krishnan', specialty: 'Dermatology' } }),
    prisma.doctor.create({ data: { name: 'Dr. Rohan Mehta', specialty: 'Orthopedics' } }),
    prisma.doctor.create({ data: { name: 'Dr. Sunita Pillai', specialty: 'Gynecology' } }),
  ]);

  console.log(`Created ${doctors.length} doctors`);

  // Generate slots for next 14 days
  const slots: { doctorId: string; startTime: Date; endTime: Date }[] = [];
  const slotHours = [9, 10, 11, 14, 15, 16, 17]; // clinic hours

  for (const doctor of doctors) {
    for (let day = 1; day <= 14; day++) {
      const base = addDays(new Date(), day);

      // Skip Sundays
      if (base.getDay() === 0) continue;

      for (const hour of slotHours) {
        const startTime = new Date(base);
        startTime.setHours(hour, 0, 0, 0);

        const endTime = new Date(startTime);
        endTime.setMinutes(30);

        slots.push({ doctorId: doctor.id, startTime, endTime });
      }
    }
  }

  await prisma.slot.createMany({ data: slots });
  console.log(`Created ${slots.length} appointment slots`);

  // Sample patient
  const patient = await prisma.patient.create({
    data: {
      phone: '+919876543210',
      name: 'Ananya Kumar',
      preferredLang: 'EN',
      memories: {
        create: [
          {
            content: 'Patient called to book a cardiology appointment. Mentioned chest discomfort during exercise.',
            type: 'INTERACTION_SUMMARY',
          },
          {
            content: 'Prefers morning appointments. Has a preference for Dr. Arjun Nair.',
            type: 'PREFERENCE',
          },
        ],
      },
    },
  });

  console.log(`Created sample patient: ${patient.name} (${patient.phone})`);
  console.log('Seed complete!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
