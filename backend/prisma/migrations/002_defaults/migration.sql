-- Default email templates and pipeline stages. Editable later in Settings.

insert into email_templates (id, name, subject, body, category) values
  ('t_received', 'Application received', 'We received your application for {{job_title}}', 'Hi {{first_name}},

Thank you for applying for the {{job_title}} role at {{company}}. Our team is reviewing your resume and we''ll be in touch within 5 business days.

Best,
{{sender_name}}', 'stage_update'),
  ('t_shortlisted', 'You''ve been shortlisted', 'Next steps for {{job_title}} at {{company}}', 'Hi {{first_name}},

Good news — we''d love to learn more about you for the {{job_title}} role. Please pick a time for a short intro call here:
{{booking_link}}

Looking forward to it,
{{sender_name}}', 'stage_update'),
  ('t_interview', 'Interview invitation', 'Interview invitation · {{job_title}}', 'Hi {{first_name}},

We''d like to invite you to interview for {{job_title}}. Choose a slot that works for you:
{{booking_link}}

You''ll receive a Google Calendar invite with the meeting link once booked.

Thanks,
{{sender_name}}', 'interview'),
  ('t_final', 'Final interview', 'Final round for {{job_title}}', 'Hi {{first_name}},

Thank you for your time so far. We''d like to invite you to a final interview with our leadership team. Please book a time here: {{booking_link}}

Best,
{{sender_name}}', 'interview'),
  ('t_offer', 'Offer coming your way', 'An offer from {{company}}', 'Hi {{first_name}},

We''re thrilled to let you know we''ll be extending an offer for the {{job_title}} position. Your formal offer letter will follow shortly from our People team.

Congratulations!
{{sender_name}}', 'offer'),
  ('t_welcome', 'Welcome & onboarding', 'Welcome to {{company}}, {{first_name}}!', 'Hi {{first_name}},

Welcome aboard! Over the next few days you''ll receive your onboarding checklist, equipment details and first-week schedule.

We''re excited to have you,
{{sender_name}}', 'stage_update'),
  ('t_rejection', 'Not moving forward', 'Your application for {{job_title}}', 'Hi {{first_name}},

Thank you for your interest in {{company}} and for the time you invested in the process. After careful consideration, we''ve decided not to move forward at this time.

We''ll keep your resume on file and reach out if a better fit opens up.

Warm regards,
{{sender_name}}', 'rejection'),
  ('t_checkin', 'Status check-in', 'An update on your application', 'Hi {{first_name}},

A quick update: your application for {{job_title}} is currently in the {{stage}} stage. We appreciate your patience and will share next steps soon.

Best,
{{sender_name}}', 'general')
on conflict (id) do nothing;

insert into stages (id, name, color, kind, position, auto_email_template_id) values
  ('screening', 'Screening', '#2a78d6', 'active', 0, 't_received'),
  ('shortlisted', 'Shortlisted', '#eb6834', 'active', 1, 't_shortlisted'),
  ('interview', 'Interview', '#1baf7a', 'active', 2, 't_interview'),
  ('final', 'Final Interview', '#eda100', 'active', 3, 't_final'),
  ('offer', 'Offer', '#4a3aa7', 'active', 4, 't_offer'),
  ('onboarding', 'Onboarding', '#008300', 'hired', 5, 't_welcome'),
  ('rejected', 'Not moving forward', '#e34948', 'closed', 6, 't_rejection')
on conflict (id) do nothing;
