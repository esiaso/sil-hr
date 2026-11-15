import { Column, Entity, PrimaryColumn } from 'typeorm';
import { AppBaseEntity } from '../../common/base.entity';

@Entity('announcement')
export class Announcement extends AppBaseEntity {
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'text' }) body: string;
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) branchIds: string[];
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) departmentIds: string[];
  @Column({ type: 'timestamptz', precision: 3 }) publishAt: Date;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) expiresAt: Date | null;
  @Column({ type: 'boolean', default: false }) pinned: boolean;
  @Column({ type: 'varchar', length: 10, default: 'draft' }) status: 'draft' | 'published' | 'withdrawn';
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) notifiedAt: Date | null;
}

@Entity('policy_document')
export class PolicyDocument extends AppBaseEntity {
  @Column({ type: 'varchar', length: 30 }) code: string;
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'varchar', length: 20 }) category: string;
  @Column({ type: 'varchar', length: 2000, nullable: true }) description: string | null;
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) departmentIds: string[];
  @Column({ type: 'boolean', default: true }) requiresAck: boolean;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'retired';
  @Column({ type: 'uuid', nullable: true }) currentVersionId: string | null;
}

@Entity('policy_version')
export class PolicyVersion extends AppBaseEntity {
  @Column({ type: 'uuid' }) policyId: string;
  @Column({ type: 'int' }) versionNo: number;
  @Column({ type: 'uuid' }) documentId: string;
  @Column({ type: 'date' }) effectiveFrom: string;
  @Column({ type: 'varchar', length: 2000, nullable: true }) changes: string | null;
}

@Entity('meeting_room')
export class MeetingRoom extends AppBaseEntity {
  @Column({ type: 'varchar', length: 120 }) name: string;
  @Column({ type: 'varchar', length: 200, nullable: true }) location: string | null;
  @Column({ type: 'int', nullable: true }) capacity: number | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) facilities: string | null;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'inactive';
}

@Entity('meeting')
export class Meeting extends AppBaseEntity {
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'uuid', nullable: true }) roomId: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) location: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) onlineLink: string | null;
  @Column({ type: 'timestamptz', precision: 3 }) startsAt: Date;
  @Column({ type: 'timestamptz', precision: 3 }) endsAt: Date;
  @Column({ type: 'uuid' }) organiserUserId: string;
  @Column({ type: 'text', nullable: true }) agenda: string | null;
  @Column({ type: 'varchar', length: 10, default: 'scheduled' }) status: 'scheduled' | 'held' | 'cancelled';
  @Column({ type: 'text', nullable: true }) minutes: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) minutesAt: Date | null;
}

@Entity('meeting_attendee')
export class MeetingAttendee {
  @PrimaryColumn({ type: 'uuid' }) meetingId: string;
  @PrimaryColumn({ type: 'uuid' }) userId: string;
  @Column({ type: 'varchar', length: 10, default: 'pending' }) response: 'pending' | 'accepted' | 'tentative' | 'declined';
  @Column({ type: 'boolean', nullable: true }) attended: boolean | null;
}

@Entity('meeting_action')
export class MeetingAction extends AppBaseEntity {
  @Column({ type: 'uuid' }) meetingId: string;
  @Column({ type: 'varchar', length: 1000 }) description: string;
  @Column({ type: 'uuid', nullable: true }) ownerUserId: string | null;
  @Column({ type: 'date', nullable: true }) dueDate: string | null;
  @Column({ type: 'varchar', length: 6, default: 'open' }) status: 'open' | 'done';
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) doneAt: Date | null;
}

export const WORKPLACE_ENTITIES = [Announcement, PolicyDocument, PolicyVersion, MeetingRoom, Meeting, MeetingAttendee, MeetingAction];
