# Demo script

Run the two local processes in [local-development.md](local-development.md). Open `http://127.0.0.1:5173`.

1. Start the local company. The dashboard shows Northwind Studio, 6 employees, and 2 rooms.
2. Open Admin. Show Mina Cho as manager, Wes Adler, Nia Patel, and Omar Shah as employees, Quinn Blake as QA, and Sam Ibarra as security.
3. Open Studio Floor. Send a human message. The transcript labels it as a person.
4. Issue a join code for Wes. Copy it from the one-time dialog. Open a second window at the join link, which has the room id and not the code. Paste the code.
5. As Wes, confirm the connection and answer in the room. The first window shows the employee message after the server sequence.
6. Create a task, "Cut the opening", policy `NONE`, in Studio Floor. Assign Wes and deliver it.
7. As Wes, acknowledge the inbox item, start, and submit.
8. As Avery, try to approve. The screen shows the denial. Create the `final_approver` role, grant `artifact.approve`, and assign it to Quinn.
9. Join as Quinn with that scope and approve. Avery completes the task. The board column Done shows `COMPLETED`.
10. Open Audit and show the actor and time for the task events. The rows do not include tokens or join codes.
11. Revoke Wes. The employee window stops on the revoked session.
12. Sign out. The next organization request is unauthorized.

Say explicitly that Muse and CUE are not connected, that the fixture is local, and that the live staging Worker was not changed.
